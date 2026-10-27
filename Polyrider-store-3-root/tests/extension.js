// Runs the REAL customer download (gate.js, license.js, content.js) in a simulated Chrome page
// against a real store server, to check the license gate end to end.   Run: node tests/extension.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const AdmZip = require("adm-zip");
const { JSDOM, VirtualConsole } = require("jsdom");
const quiet = new VirtualConsole(); // jsdom can't navigate pages; ignore those messages
const nodeCrypto = require("crypto");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyrider-ext-"));
Object.assign(process.env, {
  NODE_ENV: "test", PORT: "0", DATABASE_URL: "file:" + path.join(tmp, "t.db"),
  SERVER_SECRET: "ext-test-secret-0123456789-0123456789", ADMIN_EMAIL: "o@example.com", ADMIN_PASSWORD: "x".repeat(12),
  BTC_ADDRESS: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", SWEEP_SECONDS: "3600",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(1); console.log("PASS", name); }
  catch (e) { results.push(0); console.log("FAIL", name, "\n   ", e.message); }
}

// one simulated Chrome profile = one storage + one background worker
function makeBrowser(files, { fetchImpl } = {}) {
  const store = {};
  const listeners = [];
  const manifest = JSON.parse(files["manifest.json"]);
  const storage = { local: {
    get: (keys, cb) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); setTimeout(() => cb(o)); },
    set: (o, cb) => { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); cb && setTimeout(cb); },
  } };
  const bg = { chrome: { storage, runtime: { getManifest: () => manifest, onMessage: { addListener: (f) => listeners.push(f) } } },
    fetch: (...a) => (bg.fetchImpl || fetch)(...a), fetchImpl, crypto: { randomUUID: () => nodeCrypto.randomUUID() }, AbortSignal, console, setTimeout, JSON, Date };
  vm.runInNewContext(files["license.js"], bg);
  function openPage() {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
      url: "https://polymarket.us/event/btc-updown-5m-2026-01-01-0000z", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet });
    const w = dom.window;
    w.fetch = () => Promise.reject(new Error("offline in test"));
    w.chrome = { storage, runtime: { getManifest: () => manifest, lastError: undefined,
      sendMessage: (msg, cb) => { for (const f of listeners) f(msg, {}, (r) => setTimeout(() => cb(r))); } } };
    w.location.reload = () => {};
    w.eval(files["gate.js"]);
    w.eval(files["content.js"]);
    return w;
  }
  return { store, bg, openPage };
}
const panel = (w) => w.document.getElementById("polyrider-panel");
const shadows = (w) => [...w.document.documentElement.children].filter((e) => e.shadowRoot).map((e) => e.shadowRoot);
const keyScreen = (w) => shadows(w).find((s) => s.getElementById("key"));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } throw new Error("timed out waiting"); }

(async () => {
  const { start } = require("../server.js");
  const server = await start();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  require("../src/config").publicUrl = BASE;
  const { run } = require("../src/db");
  const orders = require("../src/orders");
  const pkg = require("../src/package");
  await run(`INSERT INTO orders (id, view_token_hash, email, usd, btc_price, sats, address, status, created_at, quote_expires_at, updated_at)
             VALUES ('PR-TESTTEST','x','buyer@example.com',29.99,100000,30000,'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq','payment_confirmed',?,?,?)`, [Date.now(), Date.now(), Date.now()]);
  const { key, license } = await orders.approveOrder("PR-TESTTEST", "admin");
  const seed = fs.readFileSync(path.join(__dirname, "..", "release-seed", "polyrider-btc-5m-4.3.0.zip"));
  const unzip = (buf) => Object.fromEntries(new AdmZip(buf).getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName.split("/").pop(), e.getData().toString("utf8")]));
  const filesWithKey = unzip(pkg.buildCustomerZip(seed, key).buf);
  const filesNoKey = unzip(pkg.buildCustomerZip(seed, "").buf);

  await t("Without a key the trading panel does NOT start; the key screen shows", async () => {
    const b = makeBrowser(filesNoKey);
    const w = b.openPage();
    await until(() => keyScreen(w));
    await sleep(300);
    assert.equal(panel(w), null);
    w.close();
  });

  await t("A wrong key is refused and the bot stays off", async () => {
    const b = makeBrowser(filesNoKey);
    const w = b.openPage();
    const s = await until(() => keyScreen(w));
    s.getElementById("key").value = "PR-AAAA-AAAA-AAAA-AAAA";
    s.getElementById("go").click();
    await until(() => /isn't valid/.test(s.getElementById("msg").textContent));
    assert.equal(panel(w), null);
    w.close();
  });

  let first;
  await t("Typing the right key activates and starts the original PolyRider panel", async () => {
    first = makeBrowser(filesNoKey);
    const w = first.openPage();
    const s = await until(() => keyScreen(w));
    s.getElementById("key").value = key.toLowerCase();
    s.getElementById("go").click();
    await until(() => panel(w));
    const html = panel(w).shadowRoot.innerHTML;
    assert.ok(html.includes("PolyRider BTC 5m") && html.includes("v4.3.0") && html.includes('id="amt"') && html.includes('id="goal"'));
    assert.equal(keyScreen(w), undefined, "key screen removed");
    w.close();
  });

  await t("Next page load starts straight away (key remembered, cached check)", async () => {
    const w = first.openPage();
    await until(() => panel(w));
    w.close();
  });

  await t("A second computer with the same key is refused (one computer per license)", async () => {
    const b = makeBrowser(filesWithKey); // key pre-filled in this download
    const w = b.openPage();
    const s = await until(() => keyScreen(w));
    await until(() => /another computer/.test(s.getElementById("msg").textContent));
    assert.equal(panel(w), null);
    w.close();
  });

  await t("Download with the key pre-filled starts without typing (fresh computer after reset)", async () => {
    await orders.resetDevice(license.id);
    const b = makeBrowser(filesWithKey);
    const w = b.openPage();
    await until(() => panel(w));
    w.close();
    first = b;
  });

  await t("Server down: keeps working inside the 72h grace period, stops after it", async () => {
    first.bg.fetchImpl = () => Promise.reject(new Error("server down"));
    const st = first.store.lic_state;
    st.checkedAt = 0; // force a re-check
    let w = first.openPage();
    await until(() => panel(w)); w.close();
    first.store.lic_state.lastOkAt = Date.now() - 73 * 3600e3; first.store.lic_state.checkedAt = 0;
    w = first.openPage();
    const s = await until(() => keyScreen(w));
    await until(() => /Can't reach the license server/.test(s.getElementById("msg").textContent));
    assert.equal(panel(w), null);
    w.close();
    first.bg.fetchImpl = undefined;
  });

  await t("Suspended: blocked at the next check; reactivated: works again", async () => {
    await orders.setLicenseStatus(license.id, "suspend");
    first.store.lic_state.checkedAt = 0;
    let w = first.openPage();
    const s = await until(() => keyScreen(w));
    await until(() => /suspended/.test(s.getElementById("msg").textContent));
    assert.equal(panel(w), null); w.close();
    await orders.setLicenseStatus(license.id, "reactivate");
    w = first.openPage(); // the saved key is checked again and works — no retyping
    await until(() => panel(w)); w.close();
  });

  await t("Update notice appears when a newer version is published", async () => {
    const z = new AdmZip(seed); const m = JSON.parse(z.readAsText("manifest.json")); m.version = "4.4.0";
    z.updateFile("manifest.json", Buffer.from(JSON.stringify(m)));
    const v = pkg.validateRelease(z.toBuffer(), "4.3.0");
    await run("UPDATE releases SET is_current=0");
    await run("INSERT INTO releases (version, notes, zip, sha256, size, is_current, created_at) VALUES (?,?,?,?,?,1,?)", [v.version, "", z.toBuffer(), v.sha256, 1, Date.now()]);
    first.store.lic_state.checkedAt = 0;
    const w = first.openPage();
    await until(() => panel(w));
    await until(() => shadows(w).some((s) => /v4\.4\.0<\/b> is available/.test(s.innerHTML)));
    w.close();
  });

  console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
  server.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
