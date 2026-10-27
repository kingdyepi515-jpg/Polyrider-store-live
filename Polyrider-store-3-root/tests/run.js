// End-to-end tests against a fake blockchain + fake price feed (no real money, no real network).
// Run:  npm test
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const AdmZip = require("adm-zip");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyrider-test-"));
const MAILS = path.join(tmp, "mails.jsonl");
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; // a valid sample address (test only)

// ------------------------------------------------------------ fake mempool.space + price feed
const chain = { tip: 900000, txs: {}, byAddr: {} };
function addTx(txid, address, value, height) {
  const tx = { txid, vout: [{ scriptpubkey_address: address, value }, { scriptpubkey_address: "bc1qchange", value: 12345 }],
    status: height ? { confirmed: true, block_height: height, block_time: Math.floor(Date.now() / 1000) } : { confirmed: false } };
  chain.txs[txid] = tx;
  (chain.byAddr[address] = chain.byAddr[address] || []).unshift(tx);
  return tx;
}
function confirm(txid, height) { chain.txs[txid].status = { confirmed: true, block_height: height, block_time: Math.floor(Date.now() / 1000) }; }
const mock = http.createServer((req, res) => {
  const u = req.url;
  const send = (code, body) => { res.writeHead(code, { "content-type": typeof body === "string" ? "text/plain" : "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (u === "/price") return send(200, { usd: 100000 });
  if (u === "/api/blocks/tip/height") return send(200, String(chain.tip));
  let m;
  if ((m = u.match(/^\/api\/tx\/([0-9a-f]{64})$/))) return chain.txs[m[1]] ? send(200, chain.txs[m[1]]) : send(404, "Transaction not found");
  if ((m = u.match(/^\/api\/address\/([^/]+)\/txs$/))) return send(200, chain.byAddr[m[1]] || []);
  send(404, "nope");
});

const txid = (n) => n.toString(16).padStart(64, "a");
let BASE;
const jar = {};
async function call(method, p, body, { admin = false, raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !Buffer.isBuffer(body)) h["content-type"] = "application/json";
  if (admin) { h["x-requested-with"] = "polyrider-admin"; if (jar.c) h.cookie = jar.c; }
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc && sc.startsWith("pr_admin=")) jar.c = sc.split(";")[0];
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
const mails = () => (fs.existsSync(MAILS) ? fs.readFileSync(MAILS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, e.message]); console.log("FAIL", name, "\n   ", e.message); }
}

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const mp = mock.address().port;
  Object.assign(process.env, {
    NODE_ENV: "test", PORT: "0", DATABASE_URL: "file:" + path.join(tmp, "test.db"),
    SERVER_SECRET: "test-secret-0123456789-0123456789-abcdef", ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "correct horse battery",
    BTC_ADDRESS: ADDRESS, MEMPOOL_API: `http://127.0.0.1:${mp}/api`, PRICE_API_OVERRIDE: `http://127.0.0.1:${mp}/price`,
    EMAIL_CAPTURE_FILE: MAILS, CONFIRMATIONS_REQUIRED: "2", SWEEP_SECONDS: "3600", SUPPORT_EMAIL: "help@example.com",
  });
  const { start } = require("../server.js");
  const server = await start();
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = BASE;
  require("../src/config").publicUrl = BASE;

  let A, B; // two customers: {id, token, sats}
  const view = async (o) => call("POST", "/api/order/view", { t: o.token });
  const sweep = () => require("../server.js").sweep();

  await t("18. Admin area refuses everyone who isn't logged in", async () => {
    for (const p of ["/api/admin/orders", "/api/admin/me", "/api/admin/audit", "/api/admin/backup"]) assert.equal((await call("GET", p)).status, 401, p);
    assert.equal((await call("POST", "/api/admin/order/X/approve", {})).status, 401);
    assert.equal((await call("POST", "/api/admin/login", { email: "owner@example.com", password: "wrong" })).status, 401);
    assert.equal((await call("POST", "/api/admin/login", { email: "x@example.com", password: "correct horse battery" })).status, 401);
  });

  await t("1. Invalid email is refused, valid email creates an order", async () => {
    assert.equal((await call("POST", "/api/orders", { email: "not-an-email" })).status, 400);
    const r = await call("POST", "/api/orders", { email: "Alice@Example.com" });
    assert.equal(r.status, 200); assert.match(r.id, /^PR-[A-Z0-9]{8}$/); assert.ok(r.token.length > 20);
    A = r;
  });

  await t("2+3. Order is stored correctly; QR + address + exact BTC amount match", async () => {
    const v = await view(A);
    assert.equal(v.status, "awaiting_payment"); assert.equal(v.email, "alice@example.com"); assert.equal(v.address, ADDRESS);
    assert.equal(v.usd, 29.99);
    const sats = Math.round(+v.btc * 1e8);
    assert.ok(sats > 29990 && sats < 29990 + 1001, "amount = $29.99 at $100k + tiny unique offset, got " + sats);
    assert.ok(v.bip21.startsWith(`bitcoin:${ADDRESS}?amount=${v.btc}`));
    assert.ok(v.qrSvg && v.qrSvg.startsWith("<svg"));
    A.sats = sats;
    const B0 = await call("POST", "/api/orders", { email: "bob@example.com" });
    B = { ...B0, sats: Math.round(+(await view(B0)).btc * 1e8) };
    assert.notEqual(A.sats, B.sats, "two open orders never share the same amount");
    assert.ok(mails().some((m) => m.to === "alice@example.com" && /payment details/.test(m.subject)), "order email sent");
  });

  await t("Order page can't be opened by guessing the order number", async () => {
    assert.equal((await call("POST", "/api/order/view", { t: A.id })).status, 404);
    assert.equal((await call("POST", "/api/order/view", { t: "x".repeat(32) })).status, 404);
  });

  await t("4. Unpaid order gets no license and admin can't approve it normally", async () => {
    await sweep();
    assert.equal((await view(A)).status, "awaiting_payment");
    const lg = await call("POST", "/api/admin/login", { email: "owner@example.com", password: "correct horse battery" });
    assert.equal(lg.step, "code", "with email set up, login needs the emailed code");
    assert.equal((await call("GET", "/api/admin/orders")).status, 401, "password alone is not enough");
    assert.equal((await call("POST", "/api/admin/login/code", { pending: lg.pending, code: "000000" })).status, 401);
    const code = mails().filter((m) => /login code/.test(m.subject)).pop().subject.match(/(\d{6})/)[1];
    const ok = await call("POST", "/api/admin/login/code", { pending: lg.pending, code });
    assert.equal(ok.step, "done");
    const r = await call("POST", `/api/admin/order/${A.id}/approve`, {}, { admin: true });
    assert.equal(r.status, 400); assert.match(r.error, /isn't confirmed/);
  });

  await t("Wrong-network / fake transaction ID is rejected", async () => {
    const r = await call("POST", "/api/order/txid", { t: A.token, txid: txid(999) });
    assert.equal(r.status, 400); assert.match(r.error, /can't find that transaction/);
    const r2 = await call("POST", "/api/order/txid", { t: A.token, txid: "hello" });
    assert.equal(r2.status, 400);
    addTx(txid(998), "bc1qsomeoneelse", A.sats, null);
    const r3 = await call("POST", "/api/order/txid", { t: A.token, txid: txid(998) });
    assert.equal(r3.status, 400); assert.match(r3.error, /didn't send bitcoin to this order's address/);
  });

  await t("5. Unconfirmed payment is detected automatically but gets NO license", async () => {
    addTx(txid(1), ADDRESS, A.sats, null);
    await sweep();
    const v = await view(A);
    assert.equal(v.status, "payment_detected"); assert.equal(v.txid, txid(1)); assert.equal(v.confirmations, 0);
    chain.tip += 1; confirm(txid(1), chain.tip); await sweep(); // 1 of 2 confirmations
    assert.equal((await view(A)).status, "payment_detected");
    assert.equal((await call("POST", `/api/admin/order/${A.id}/approve`, {}, { admin: true })).status, 400);
    assert.ok(!mails().some((m) => /license key/.test(m.subject)));
  });

  await t("6+7+8. Confirmed payment waits for owner approval; approval issues a unique key and emails it", async () => {
    chain.tip += 1; await sweep();
    const v = await view(A);
    assert.equal(v.status, "payment_confirmed"); assert.equal(v.licenseReady, false, "no license before the owner approves");
    const r = await call("POST", `/api/admin/order/${A.id}/approve`, {}, { admin: true });
    assert.equal(r.status, 200); assert.match(r.key, /^PR-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/); assert.equal(r.emailed, true);
    A.key = r.key;
    const m = mails().find((x) => x.to === "alice@example.com" && /license key/.test(x.subject));
    assert.ok(m && m.text.includes(A.key) && m.text.includes("/download.html") && m.text.includes("/install.html"));
    assert.equal((await view(A)).status, "approved");
  });

  await t("14. Approving twice / duplicate notices never create a second license", async () => {
    const r = await call("POST", `/api/admin/order/${A.id}/approve`, {}, { admin: true });
    assert.equal(r.already, true); assert.equal(r.key, A.key);
    await sweep(); await sweep();
    const list = await call("GET", "/api/admin/orders", undefined, { admin: true });
    assert.equal(list.rows.filter((x) => x.id === A.id && x.license_id).length, 1);
    // same transaction can't be claimed by another order
    const r2 = await call("POST", "/api/order/txid", { t: B.token, txid: txid(1) });
    assert.equal(r2.status, 400); assert.match(r2.error, /already linked/);
  });

  await t("Underpayment goes to review, not to a license", async () => {
    addTx(txid(2), ADDRESS, B.sats - 5000, chain.tip);
    const r = await call("POST", "/api/order/txid", { t: B.token, txid: txid(2) });
    assert.equal(r.status, "requires_review"); assert.match(r.reviewReason, /Underpaid/);
    assert.equal(r.licenseReady, false);
  });

  await t("Expired quote: order expires; payment within 24h accepted with a note, later held for review", async () => {
    const C = await call("POST", "/api/orders", { email: "carol@example.com" });
    const { run } = require("../src/db");
    await run("UPDATE orders SET quote_expires_at=? WHERE id=?", [Date.now() - 3600e3, C.id]);
    await sweep();
    assert.equal((await view(C)).status, "expired");
    const sats = Math.round(+(await view(C)).btc * 1e8);
    addTx(txid(3), ADDRESS, sats, chain.tip - 1);
    await sweep();
    let v = await view(C);
    assert.equal(v.status, "payment_confirmed");
    const d = await call("GET", `/api/admin/order/${C.id}`, undefined, { admin: true });
    assert.match(d.order.review_reason, /after the quote expired/);
    const C2 = await call("POST", "/api/orders", { email: "carol2@example.com" }, { headers: { "x-forwarded-for": "10.0.0.60" } });
    await run("UPDATE orders SET quote_expires_at=?, created_at=? WHERE id=?", [Date.now() - 30 * 3600e3, Date.now() - 31 * 3600e3, C2.id]);
    await sweep();
    const sats2 = Math.round(+(await view(C2)).btc * 1e8);
    addTx(txid(6), ADDRESS, sats2, chain.tip);
    v = await call("POST", "/api/order/txid", { t: C2.token, txid: txid(6) });
    assert.equal(v.status, "requires_review"); assert.match(v.reviewReason, /more than 24 hours/);
  });

  await t("Overpayment is accepted and noted", async () => {
    const D = await call("POST", "/api/orders", { email: "dan@example.com" });
    const sats = Math.round(+(await view(D)).btc * 1e8);
    addTx(txid(4), ADDRESS, sats * 2, chain.tip - 1);
    const r = await call("POST", "/api/order/txid", { t: D.token, txid: txid(4) });
    assert.equal(r.status, "payment_confirmed");
    const d = await call("GET", `/api/admin/order/${D.id}`, undefined, { admin: true });
    assert.match(d.order.review_reason, /Overpaid/);
  });

  let dlUrl;
  await t("9. The right customer can download; ZIP contains their key and this store's address", async () => {
    const r = await call("POST", "/api/download/request", { email: "alice@example.com", key: A.key.toLowerCase() });
    assert.equal(r.status, 200); assert.match(r.url, /^\/dl\//);
    dlUrl = r.url;
    const res = await call("GET", r.url, undefined, { raw: true });
    assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/zip");
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(names.includes("PolyRider-BTC-5m-v4.3.0/manifest.json"));
    const lic = zip.readAsText("PolyRider-BTC-5m-v4.3.0/license.js");
    const man = JSON.parse(zip.readAsText("PolyRider-BTC-5m-v4.3.0/manifest.json"));
    assert.ok(lic.includes(`"${BASE}"`) && lic.includes(`"${A.key}"`));
    assert.ok(man.host_permissions.includes(BASE + "/*"));
    assert.ok(!/__POLYRIDER_/.test(lic + JSON.stringify(man)));
  });

  await t("10. Others can't download: wrong email, wrong key, guessed or tampered link", async () => {
    assert.equal((await call("POST", "/api/download/request", { email: "bob@example.com", key: A.key })).status, 403);
    assert.equal((await call("POST", "/api/download/request", { email: "alice@example.com", key: "PR-AAAA-AAAA-AAAA-AAAA" })).status, 403);
    assert.equal((await call("GET", dlUrl.slice(0, -3) + "abc", undefined, { raw: true })).status, 403);
    assert.equal((await call("GET", "/dl/" + A.id, undefined, { raw: true })).status, 403);
    assert.equal((await call("POST", "/api/download/request", { email: "bob@example.com", key: "" })).status, 403);
  });

  const DEV1 = "device1device1device1device1aa", DEV2 = "device2device2device2device2bb";
  await t("11. Extension: key activates on one computer only", async () => {
    let r = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV1, version: "4.3.0" });
    assert.equal(r.ok, true); assert.equal(r.latest.version, "4.3.0");
    r = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV1, version: "4.3.0" });
    assert.equal(r.ok, true, "same computer keeps working");
    r = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV2, version: "4.3.0" });
    assert.equal(r.ok, false); assert.equal(r.status, "in_use");
    r = await call("POST", "/api/license/verify", { key: "PR-BBBB-BBBB-BBBB-BBBB", deviceId: DEV2, version: "4.3.0" });
    assert.equal(r.ok, false); assert.equal(r.status, "invalid");
  });

  await t("Brute-force: too many wrong keys from one place gets blocked", async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await call("POST", "/api/license/verify", { key: `PR-CCCC-CCCC-CCCC-CC${"ABCDEFGHJKMN"[i]}${"ABCDEFGHJKMN"[i]}`, deviceId: DEV2 });
    assert.match(last.message, /Too many wrong license keys/);
    const ok = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV1 });
    assert.equal(ok.ok, false, "blocked for an hour even with a real key"); assert.equal(ok.status, "blocked");
  });


  const lic = async () => (await call("GET", `/api/admin/order/${A.id}`, undefined, { admin: true })).license;
  await t("12+13. Suspended license is rejected and can't download; reactivated works again", async () => {
    const L = await lic();
    let r = await call("POST", `/api/admin/license/${L.id}/suspend`, {}, { admin: true });
    assert.equal(r.status, 200);
    const verify = (dev) => fetch(BASE + "/api/license/verify", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }, body: JSON.stringify({ key: A.key, deviceId: dev, version: "4.3.0" }) }).then((x) => x.json());
    r = await verify(DEV1);
    assert.equal(r.ok, false); assert.equal(r.status, "suspended");
    assert.equal((await call("POST", "/api/download/request", { email: "alice@example.com", key: A.key }, { headers: { "x-forwarded-for": "10.0.0.9" } })).status, 403);
    assert.equal((await call("GET", dlUrl, undefined, { raw: true })).status, 403, "old download link stops working too");
    r = await call("POST", `/api/admin/license/${L.id}/reactivate`, {}, { admin: true });
    assert.equal(r.status, 200);
    r = await verify(DEV1);
    assert.equal(r.ok, true);
  });

  await t("Move to a new computer (admin reset) and permanent revoke", async () => {
    const L = await lic();
    const verify = (dev) => fetch(BASE + "/api/license/verify", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.10" }, body: JSON.stringify({ key: A.key, deviceId: dev, version: "4.3.0" }) }).then((x) => x.json());
    assert.equal((await verify(DEV2)).status, "in_use");
    await call("POST", `/api/admin/license/${L.id}/reset-device`, {}, { admin: true });
    assert.equal((await verify(DEV2)).ok, true);
    assert.equal((await verify(DEV1)).status, "in_use");
    // revoke
    const B2 = await call("POST", "/api/orders", { email: "eve@example.com" }, { headers: { "x-forwarded-for": "10.0.0.11" } });
    const sats = Math.round(+(await view(B2)).btc * 1e8);
    addTx(txid(5), ADDRESS, sats, chain.tip - 3); await sweep();
    const ap = await call("POST", `/api/admin/order/${B2.id}/approve`, {}, { admin: true });
    const L2 = (await call("GET", `/api/admin/order/${B2.id}`, undefined, { admin: true })).license;
    await call("POST", `/api/admin/license/${L2.id}/revoke`, {}, { admin: true });
    const rv = await fetch(BASE + "/api/license/verify", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.12" }, body: JSON.stringify({ key: ap.key, deviceId: DEV1 }) }).then((x) => x.json());
    assert.equal(rv.status, "revoked");
    assert.equal((await call("POST", `/api/admin/license/${L2.id}/reactivate`, {}, { admin: true })).status, 400, "revoked is permanent");
  });

  await t("15. Email failures are queued and retried safely (no duplicates)", async () => {
    const cfg = require("../src/config");
    const saved = cfg.emailCaptureFile;
    cfg.emailCaptureFile = path.join(tmp, "no-such-dir", "x.jsonl"); // writing fails → like the email service being down
    const before = mails().length;
    const r = await call("POST", `/api/admin/order/${A.id}/resend`, {}, { admin: true });
    assert.equal(r.sent, false);
    cfg.emailCaptureFile = saved;
    await require("../src/email").retryPending();
    await require("../src/email").retryPending();
    const after = mails();
    assert.equal(after.length, before + 1, "sent exactly once after retry");
    assert.ok(after[after.length - 1].text.includes(A.key));
  });

  await t("Recovery: lost key is emailed only to the owner's address", async () => {
    const r = await call("POST", "/api/recover", { email: "alice@example.com" }, { headers: { "x-forwarded-for": "10.0.0.20" } });
    assert.equal(r.status, 200);
    const m = mails().filter((x) => x.to === "alice@example.com").pop();
    assert.match(m.subject, /orders/); assert.ok(m.text.includes(A.key));
    const n = mails().length;
    const r2 = await call("POST", "/api/recover", { email: "nobody@example.com" }, { headers: { "x-forwarded-for": "10.0.0.20" } });
    assert.equal(r2.status, 200, "same answer whether or not the email exists"); assert.equal(mails().length, n);
    // recovery link opens the order
    const link = m.text.match(/order\.html#t=([^\s]+)/)[1];
    assert.equal((await call("POST", "/api/order/view", { t: link })).id, A.id);
  });

  await t("17. Versions: validate, publish, see usage, withdraw = roll back", async () => {
    const { buildCustomerZip } = require("../src/package");
    const seed = fs.readFileSync(path.join(__dirname, "..", "release-seed", "polyrider-btc-5m-4.3.0.zip"));
    // same version is refused
    let r = await call("POST", "/api/admin/releases", seed, { admin: true, headers: { "content-type": "application/zip" } });
    assert.equal(r.status, 400); assert.match(r.error, /higher/);
    // junk refused
    r = await call("POST", "/api/admin/releases", Buffer.from("not a zip"), { admin: true, headers: { "content-type": "application/zip" } });
    assert.equal(r.status, 400);
    // make 4.3.1
    const z = new AdmZip(seed); const m = JSON.parse(z.readAsText("manifest.json")); m.version = "4.3.1";
    z.updateFile("manifest.json", Buffer.from(JSON.stringify(m)));
    r = await call("POST", "/api/admin/releases", z.toBuffer(), { admin: true, headers: { "content-type": "application/zip", "x-notes": "Fixes", "x-make-current": "1" } });
    assert.equal(r.status, 200); assert.equal(r.version, "4.3.1");
    let v = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV2, version: "4.3.0" }, { headers: { "x-forwarded-for": "10.0.0.30" } });
    assert.equal(v.latest.version, "4.3.1", "installed copies are told an update exists");
    const rel = await call("GET", "/api/admin/releases", undefined, { admin: true });
    assert.equal(rel.usage.find((u) => u.version === "4.3.0").n >= 1, true);
    const id431 = rel.rows.find((x) => x.version === "4.3.1").id;
    await call("POST", `/api/admin/releases/${id431}/withdraw`, {}, { admin: true });
    v = await call("POST", "/api/license/verify", { key: A.key, deviceId: DEV2, version: "4.3.0" }, { headers: { "x-forwarded-for": "10.0.0.30" } });
    assert.equal(v.latest.version, "4.3.0", "rolled back");
    assert.ok(buildCustomerZip);
  });

  await t("Audit log records owner actions", async () => {
    const a = (await call("GET", "/api/admin/audit", undefined, { admin: true })).rows.map((x) => x.action);
    for (const k of ["payment_approved", "license_issued", "license_suspended", "license_active", "license_revoked", "license_device_reset", "release_uploaded", "release_published", "release_withdrawn", "instructions_resent"])
      assert.ok(a.includes(k), "missing " + k);
  });

  await t("Settings: bad Bitcoin address refused; sales can be paused", async () => {
    assert.equal((await call("POST", "/api/admin/settings", { btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx" }, { admin: true })).status, 400);
    await call("POST", "/api/admin/settings", { sales_open: false }, { admin: true });
    assert.equal((await call("POST", "/api/orders", { email: "zed@example.com" }, { headers: { "x-forwarded-for": "10.0.0.40" } })).status, 503);
    await call("POST", "/api/admin/settings", { sales_open: true }, { admin: true });
  });

  await t("Admin requests without the anti-forgery header are blocked", async () => {
    const r = await fetch(BASE + `/api/admin/order/${A.id}/resend`, { method: "POST", headers: { cookie: jar.c, "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  await t("20. No secrets in the public site or the extension download", async () => {
    const secretish = [process.env.SERVER_SECRET, process.env.ADMIN_PASSWORD, "test-secret"];
    const pubDir = path.join(__dirname, "..", "public");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of [...walk(pubDir), ...walk(path.join(__dirname, "..", "extension"))]) {
      const s = fs.readFileSync(f, "utf8");
      for (const x of secretish) assert.ok(!s.includes(x), `${f} contains a secret`);
      assert.ok(!/SERVER_SECRET|BREVO_API_KEY|DATABASE_AUTH_TOKEN/.test(s), `${f} mentions a secret setting`);
    }
    const page = await (await fetch(BASE + "/")).text();
    assert.ok(!secretish.some((x) => page.includes(x)));
    const r = await fetch(BASE + "/api/nope"); assert.equal(r.status, 404);
    const e = await call("POST", "/api/orders", "x".repeat(30000), { headers: { "x-forwarded-for": "10.0.0.50" } });
    assert.ok(e.status >= 400 && !/\bat \w+ \(|node_modules/.test(JSON.stringify(e)), "no stack traces: " + JSON.stringify(e));
  });

  await t("16. The original PolyRider code is unchanged except the 3 licensing lines", async () => {
    const o = fs.readFileSync(path.join(__dirname, "..", "extension-original", "content.js"), "utf8").split("\n");
    const n = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8").split("\n");
    assert.equal(o.length, n.length);
    const changed = o.map((l, i) => (l !== n[i] ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(changed, [8, 418, 427], "only the version label and the start/end of the start-up block changed");
  });

  console.log(`\n${results.filter((r) => r[0] === "PASS").length} passed, ${results.filter((r) => r[0] === "FAIL").length} failed`);
  server.close(); mock.close();
  process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
