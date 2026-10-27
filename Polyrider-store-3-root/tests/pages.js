// Smoke test: loads the real web pages (HTML + their scripts) in a simulated browser against a real
// server and clicks through buying, the order page, the download page and the admin panel.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyrider-pages-"));
const chain = { tip: 800000, txs: {}, byAddr: {} };
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const mock = http.createServer((req, res) => {
  const j = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  let m;
  if (req.url === "/price") return j(200, { usd: 95000 });
  if (req.url === "/api/blocks/tip/height") { res.end(String(chain.tip)); return; }
  if ((m = req.url.match(/^\/api\/tx\/(\w+)$/))) return chain.txs[m[1]] ? j(200, chain.txs[m[1]]) : (res.writeHead(404), res.end("nf"));
  if ((m = req.url.match(/^\/api\/address\/(\w+)\/txs$/))) return j(200, chain.byAddr[m[1]] || []);
  res.writeHead(404); res.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = fn(); if (last) return last; } catch {} await sleep(50); } throw new Error("timed out"); }
const results = [];
async function t(name, fn) { try { await fn(); results.push(1); console.log("PASS", name); } catch (e) { results.push(0); console.log("FAIL", name, "\n   ", e.stack.split("\n").slice(0, 3).join("\n    ")); } }

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const mp = mock.address().port;
  Object.assign(process.env, {
    NODE_ENV: "test", PORT: "0", DATABASE_URL: "file:" + path.join(tmp, "p.db"),
    SERVER_SECRET: "pages-test-secret-0123456789-0123456789", ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "owner-password-1",
    BTC_ADDRESS: ADDRESS, MEMPOOL_API: `http://127.0.0.1:${mp}/api`, PRICE_API_OVERRIDE: `http://127.0.0.1:${mp}/price`, SWEEP_SECONDS: "3600",
  });
  const { start, sweep } = require("../server.js");
  const server = await start();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  require("../src/config").publicUrl = BASE;

  const errors = [];
  async function open(p, cookieJar = {}) {
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/navigation|Not implemented/i.test(e.message)) errors.push(p + ": " + e.message); });
    const html = await (await fetch(BASE + p.split("#")[0])).text();
    const dom = new JSDOM(html, {
      url: BASE + p, runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.fetch = async (u, o = {}) => {
          const headers = { ...(o.headers || {}) };
          if (cookieJar.c) headers.cookie = cookieJar.c;
          const body = o.body && typeof o.body !== "string" && o.body.arrayBuffer ? Buffer.from(await o.body.arrayBuffer()) : o.body;
          const r = await fetch(new URL(u, BASE), { ...o, headers, body });
          const sc = r.headers.get("set-cookie"); if (sc && sc.startsWith("pr_admin=")) cookieJar.c = sc.split(";")[0];
          return r;
        };
        w.alert = (m) => (w.__alerts = (w.__alerts || []).concat(m));
        w.confirm = () => true;
        w.prompt = () => "REVOKE";
        w.navigator.clipboard = { writeText: async () => {} };
      },
    });
    await new Promise((r) => dom.window.addEventListener("load", r));
    return dom.window;
  }

  let orderUrl;
  await t("Home page: Buy Now with an email opens the private order page", async () => {
    const w = await open("/");
    await until(() => w.document.querySelector("[data-price]").textContent === "$29.99");
    w.document.getElementById("email").value = "bad";
    w.document.getElementById("orderForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    assert.match(w.document.getElementById("err").textContent, /valid email/);
    let target = null;
    Object.defineProperty(w, "__go", { value: (u) => (target = u) });
    w.document.getElementById("email").value = "page@example.com";
    // capture the redirect instead of navigating
    const orig = w.location.href;
    w.document.getElementById("orderForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => w.document.getElementById("buyBtn").textContent.includes("Creating") === false || w.location.href !== orig, 3000).catch(() => {});
    await sleep(500);
    const { all } = require("../src/db");
    const o = (await all("SELECT id FROM orders WHERE email='page@example.com'"))[0];
    assert.ok(o, "order created from the page");
    // get a viewable link the way the recovery email would
    orderUrl = "/order.html#t=" + require("../src/security").signToken({ k: "ov", o: o.id }, 3600e3);
    w.close();
  });

  await t("Order page: shows QR, exact amount, address, countdown", async () => {
    const w = await open(orderUrl);
    await until(() => !w.document.getElementById("app").classList.contains("hide"));
    const d = w.document;
    assert.match(d.getElementById("statusText").textContent, /Awaiting payment/);
    assert.ok(d.querySelector("#qr svg"));
    assert.equal(d.getElementById("addr").textContent, ADDRESS);
    assert.match(d.getElementById("btc2").textContent, /^0\.000\d+$/);
    await until(() => /^\d+:\d\d$/.test(d.getElementById("timer").textContent));
    // pay it
    const sats = Math.round(+d.getElementById("btc2").textContent * 1e8);
    const tx = { txid: "b".repeat(64), vout: [{ scriptpubkey_address: ADDRESS, value: sats }], status: { confirmed: true, block_height: chain.tip, block_time: Math.floor(Date.now() / 1000) } };
    chain.txs[tx.txid] = tx; chain.byAddr[ADDRESS] = [tx];
    d.getElementById("txid").value = tx.txid;
    d.getElementById("txForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => /confirmed — waiting for seller approval/.test(d.getElementById("statusText").textContent));
    assert.ok(d.getElementById("payBox").classList.contains("hide"));
    w.close();
  });

  let key;
  await t("Admin: login, sees the order needing attention, approves it, sees the key", async () => {
    const jar = {};
    const w = await open("/admin", jar);
    const d = w.document;
    await until(() => !d.getElementById("login").classList.contains("hide"));
    d.getElementById("lEmail").value = "owner@example.com"; d.getElementById("lPw").value = "owner-password-1";
    d.getElementById("loginForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => d.querySelectorAll("#ordersTbl tbody tr").length === 1);
    assert.match(d.getElementById("stats").textContent, /1Needs my attention/);
    assert.match(d.getElementById("banner").textContent, /Email isn't set up/);
    d.getElementById("fStatus").value = "approved"; d.getElementById("fStatus").dispatchEvent(new w.Event("change"));
    assert.equal(d.querySelectorAll("#ordersTbl tbody tr").length, 0, "filter works");
    d.getElementById("fStatus").value = ""; d.getElementById("fStatus").dispatchEvent(new w.Event("change"));
    d.querySelector("#ordersTbl tbody tr").click();
    await until(() => /Approve payment & issue license/.test(d.getElementById("dBody").textContent));
    [...d.querySelectorAll("#dBody button")].find((b) => /Approve payment/.test(b.textContent)).click();
    await until(() => (w.__alerts || []).some((a) => /PR-/.test(a)));
    key = w.__alerts.find((a) => /PR-/.test(a)).match(/PR-[A-Z0-9-]{19}/)[0];
    await until(() => /Suspend/.test(d.getElementById("dBody").textContent));
    [...d.querySelectorAll("#dBody button")].find((b) => b.textContent === "Show key").click();
    await until(() => d.querySelector("#dBody .keybox").textContent === key);
    // other tabs render
    w.location.hash = "#versions";
    await until(() => d.querySelectorAll("#relTbl tbody tr").length === 1);
    w.location.hash = "#audit";
    await until(() => /payment approved/.test(d.getElementById("auditTbl").textContent));
    w.location.hash = "#settings";
    await until(() => d.getElementById("sAddr").value === ADDRESS);
    w.close();
  });

  await t("Download page: wrong key refused, right key gives a 10-minute link", async () => {
    const w = await open(`/download.html#e=page%40example.com&k=${encodeURIComponent(key)}`);
    const d = w.document;
    assert.equal(d.getElementById("key").value, key, "prefilled from the email link");
    d.getElementById("key").value = "PR-AAAA-AAAA-AAAA-AAAA";
    d.getElementById("dlForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => /don't match/.test(d.getElementById("err").textContent));
    d.getElementById("key").value = key;
    d.getElementById("dlForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => !d.getElementById("ready").classList.contains("hide"));
    assert.match(d.getElementById("dlLink").getAttribute("href"), /^\/dl\//);
    assert.match(d.getElementById("dlLink").textContent, /v4\.3\.0/);
    w.close();
  });

  await t("Install page renders both guides", async () => {
    const w = await open("/install.html#mac");
    assert.ok(!w.document.getElementById("mac").classList.contains("hide"));
    assert.match(w.document.getElementById("win").textContent, /Load unpacked/);
    assert.match(w.document.getElementById("mac").textContent, /Load unpacked/);
    w.close();
  });

  await t("No JavaScript errors on any page", async () => { assert.deepEqual(errors, []); });

  console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
  server.close(); mock.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
