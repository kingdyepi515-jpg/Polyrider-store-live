// PolyRider BTC 5m store — website, Bitcoin orders, licenses, downloads and the admin panel.
const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const QRCode = require("qrcode");

const config = require("./src/config");
const dbm = require("./src/db");
const { all, one, run, getSetting, setSetting, logEvent } = dbm;
const sec = require("./src/security");
const btc = require("./src/btc");
const email = require("./src/email");
const orders = require("./src/orders");
const pkg = require("./src/package");
const { UserError } = orders;

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: {
    "default-src": ["'self'"], "img-src": ["'self'", "data:"], "style-src": ["'self'", "'unsafe-inline'"], "script-src": ["'self'"],
    "connect-src": ["'self'"], "frame-ancestors": ["'none'"], "form-action": ["'self'"], "object-src": ["'none'"],
  } },
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use("/api", express.json({ limit: "20kb" }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => Date.now();

// ===================================================================== public
app.get("/api/store", wrap(async (req, res) => {
  const cur = await currentRelease(false);
  res.json({
    productName: config.productName, priceUsd: config.priceUsd, supportEmail: config.supportEmail,
    salesOpen: await orders.salesOpen(),
    // "ready" must match what createOrder() actually requires: a Cash App $cashtag (CASH_APP_TAG).
    // It used to check for a legacy bc1... address, which made the home page say "Checkout opens soon"
    // and disable the button even though orders could be created.
    ready: !!config.cashAppTag,
    latestVersion: cur ? cur.version : null, quoteMinutes: config.quoteMinutes,
  });
}));

app.post("/api/orders", sec.rateLimit("order", 8, 3600e3), wrap(async (req, res) => {
  const { id, viewToken } = await orders.createOrder(req.body && req.body.email, req.ip);
  res.json({ id, token: viewToken });
}));

// the order page link holds a private token (or a 2-hour recovery token sent by email)
async function orderFromToken(t) {
  const s = String(t || "");
  let o = null;
  if (s.includes(".")) { const p = sec.verifyToken(s, "ov"); if (p) o = await one("SELECT * FROM orders WHERE id=?", [p.o]); }
  else if (s.length >= 20) o = await orders.byToken(s);
  if (!o) throw new UserError("We couldn't find that order. Use the link from your email, or recover it below.", 404);
  return o;
}
async function viewJson(o) {
  const lic = await one("SELECT id FROM licenses WHERE order_id=?", [o.id]);
  const v = orders.publicView(o, lic);
  if (["awaiting_payment", "expired"].includes(o.status) || (o.status === "payment_detected")) {
    v.qrSvg = await QRCode.toString(v.cashAppUrl || v.bip21, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  }
  v.emailConfigured = email.configured();
  return v;
}
app.post("/api/order/view", sec.rateLimit("view", 120, 600e3), wrap(async (req, res) => {
  res.json(await viewJson(await orderFromToken(req.body && req.body.t)));
}));
const lastCheck = new Map();
app.post("/api/order/check", sec.rateLimit("check", 40, 600e3), wrap(async (req, res) => {
  let o = await orderFromToken(req.body && req.body.t);
  let note = null;
  if (now() - (lastCheck.get(o.id) || 0) > 15000) {
    lastCheck.set(o.id, now());
    try { o = await orders.checkOrder(o, "customer"); }
    catch (e) { if (e.user) throw e; note = "We couldn't reach the Bitcoin network just now. We'll keep checking automatically."; }
  }
  res.json({ ...(await viewJson(o)), note });
}));
app.post("/api/order/txid", sec.rateLimit("txid", 15, 600e3), wrap(async (req, res) => {
  const o = await orderFromToken(req.body && req.body.t);
  let fresh;
  try { fresh = await orders.submitTxid(o, req.body.txid); }
  catch (e) { if (e.user) throw e; throw new UserError("We couldn't reach the Bitcoin network just now. Please try again in a minute."); }
  res.json(await viewJson(fresh));
}));

// lost link / lost key: we email links to the address on file (never shown on screen)
app.post("/api/recover", sec.rateLimit("recover", 5, 3600e3), wrap(async (req, res) => {
  const e = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!sec.validEmail(e)) throw new UserError("Please enter a valid email address.");
  if (!email.configured()) throw new UserError(`Email isn't set up yet. Please contact ${config.supportEmail || "the seller"} with your order number.`, 503);
  const list = await all("SELECT o.id, o.status, l.key_enc, l.status AS lstatus FROM orders o LEFT JOIN licenses l ON l.order_id=o.id WHERE o.email=? ORDER BY o.created_at DESC LIMIT 10", [e]);
  if (list.length && !sec.limited("recover-email:" + e, 3, 3600e3)) {
    const links = list.map((o) => ({
      id: o.id, status: orders.STATUS_TEXT[o.status] || o.status,
      url: `${config.publicUrl}/order.html#t=${sec.signToken({ k: "ov", o: o.id }, 2 * 3600e3)}`,
      key: o.key_enc && o.lstatus !== "revoked" ? sec.decrypt(o.key_enc) : null,
    }));
    await email.send({ to: e, kind: "recovery", ...email.recoveryEmail({ links, downloadUrl: `${config.publicUrl}/download.html` }) });
    await logEvent("customer", "recovery_email_sent", { details: { orders: list.map((o) => o.id) } });
  }
  res.json({ ok: true, message: "If that email has orders with us, we just sent the links to it. Check your inbox and spam folder." });
}));

// ------------------------------------------------------------------ download
async function currentRelease(withZip) {
  return one(`SELECT id, version, notes, sha256, size, created_at${withZip ? ", zip" : ""} FROM releases WHERE is_current=1 AND withdrawn=0 ORDER BY id DESC LIMIT 1`);
}
async function licenseFor(emailAddr, key) {
  const k = sec.normalizeKey(key);
  const e = String(emailAddr || "").trim().toLowerCase();
  if (!k || !sec.validEmail(e)) return null;
  const l = await one("SELECT l.*, o.email FROM licenses l JOIN orders o ON o.id=l.order_id WHERE l.key_hash=?", [sec.hmac("key", k)]);
  if (!l || l.email !== e) return null;
  return { ...l, key: k };
}
app.post("/api/download/request", sec.rateLimit("dlreq", 12, 900e3), wrap(async (req, res) => {
  if (sec.blocked("dlfail:" + req.ip, 8)) throw new UserError("Too many wrong attempts. Please wait an hour or use \"I lost my key\".", 429);
  const l = await licenseFor(req.body && req.body.email, req.body && req.body.key);
  if (!l) {
    sec.limited("dlfail:" + req.ip, 8, 3600e3);
    await logEvent("customer", "download_denied", { details: { reason: "bad email/key", ip: req.ip } });
    throw new UserError("That email and license key don't match an approved purchase. Check both and try again.", 403);
  }
  if (l.status !== "active") throw new UserError(l.status === "suspended" ? "This license is suspended. Please contact the seller." : "This license has been revoked.", 403);
  const rel = await currentRelease(false);
  if (!rel) throw new UserError("The download isn't available right now. Please try again later.", 503);
  const token = sec.signToken({ k: "dl", l: l.id }, 10 * 60e3);
  res.json({ url: `/dl/${token}`, version: rel.version, expiresInMinutes: 10, notes: rel.notes });
}));
app.get("/dl/:token", sec.rateLimit("dl", 20, 900e3), wrap(async (req, res) => {
  const p = sec.verifyToken(req.params.token, "dl");
  const l = p && (await one("SELECT * FROM licenses WHERE id=?", [p.l]));
  if (!l || l.status !== "active") return res.status(403).type("html").send(page("Download link expired", "This download link has expired or is no longer valid. Go back to the <a href=\"/download.html\">download page</a> and request a new one."));
  const rel = await currentRelease(true);
  if (!rel) return res.status(503).type("html").send(page("Not available", "The download isn't available right now."));
  const out = pkg.buildCustomerZip(Buffer.from(rel.zip), sec.decrypt(l.key_enc));
  await logEvent("customer", "downloaded", { orderId: l.order_id, licenseId: l.id, details: { version: rel.version } });
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" });
  res.send(out.buf);
}));
function page(title, html) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/css/style.css"><main class="wrap narrow"><div class="card"><h1>${title}</h1><p>${html}</p></div></main>`;
}

// ------------------------------------------------------------------ extension license check
app.post("/api/license/verify", sec.rateLimit("lic", 30, 600e3), wrap(async (req, res) => {
  const b = req.body || {};
  // brute-force guard: a computer that keeps sending wrong keys gets blocked for an hour
  if (sec.blocked("licfail:" + req.ip, 10)) {
    return res.status(429).json({ ok: false, status: "blocked", message: "Too many wrong license keys. Try again in an hour." });
  }
  const r = await orders.verifyLicense({ key: b.key, deviceId: b.deviceId, version: b.version });
  if (!r.ok && r.status === "invalid") sec.limited("licfail:" + req.ip, 10, 3600e3);
  const rel = await currentRelease(false);
  res.json({
    ...r, recheckMinutes: config.licenseRecheckMinutes, offlineGraceHours: config.licenseOfflineGraceHours,
    latest: rel ? { version: rel.version, notes: rel.notes } : null, downloadPage: `${config.publicUrl}/download.html`,
  });
}));

// ===================================================================== admin
const COOKIE = "pr_admin";
const cookieOpts = { httpOnly: true, secure: config.production, sameSite: "strict", path: "/" };
let envPwHash = null;
async function adminPwHash() {
  const stored = await getSetting("admin_pw_hash");
  if (stored) return stored;
  if (!config.adminPassword) return null;
  return envPwHash || (envPwHash = sec.hashPassword(config.adminPassword));
}
async function newSession(res) {
  const token = sec.randomToken(32);
  await run("INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?,?,?)", [sec.hmac("sess", token), now() + 12 * 3600e3, now()]);
  res.cookie(COOKIE, token, { ...cookieOpts, maxAge: 12 * 3600e3 });
}
async function requireAdmin(req, res, next) {
  try {
    const t = req.cookies[COOKIE];
    const s = t && (await one("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?", [sec.hmac("sess", t), now()]));
    if (!s) return res.status(401).json({ error: "Please log in." });
    if (req.method !== "GET" && req.get("x-requested-with") !== "polyrider-admin") return res.status(403).json({ error: "Blocked request." });
    next();
  } catch (e) { next(e); }
}

app.post("/api/admin/login", sec.rateLimit("login", 6, 900e3), wrap(async (req, res) => {
  const { email: e, password } = req.body || {};
  const hash = await adminPwHash();
  if (!config.adminEmail || !hash) throw new UserError("The admin account isn't set up. Add ADMIN_EMAIL and ADMIN_PASSWORD in your hosting settings.", 503);
  const emailOk = sec.safeEqual(String(e || "").trim().toLowerCase(), config.adminEmail);
  const pwOk = sec.checkPassword(String(password || ""), hash);
  if (!emailOk || !pwOk) {
    await logEvent("system", "admin_login_failed", { details: { ip: req.ip } });
    throw new UserError("Wrong email or password.", 401);
  }
  if (email.configured()) { // second step: a code emailed to you
    const code = String(require("crypto").randomInt(100000, 1000000));
    const pending = sec.randomToken(24);
    await run("INSERT INTO login_codes (code_hash, pending_hash, expires_at) VALUES (?,?,?)", [sec.hmac("code", code), sec.hmac("pend", pending), now() + 10 * 60e3]);
    const r = await email.send({ to: config.adminEmail, kind: "admin_code", ...email.adminCodeEmail(code) });
    if (!r.sent) throw new UserError("Couldn't send your login code by email. Check the email settings, then try again.", 503);
    return res.json({ step: "code", pending });
  }
  await newSession(res);
  await logEvent("admin", "admin_login", { details: { ip: req.ip, twoStep: false } });
  res.json({ step: "done" });
}));
app.post("/api/admin/login/code", sec.rateLimit("logincode", 8, 900e3), wrap(async (req, res) => {
  const { pending, code } = req.body || {};
  const row = await one("SELECT * FROM login_codes WHERE pending_hash=? AND expires_at>?", [sec.hmac("pend", String(pending || "")), now()]);
  if (!row || row.tries >= 5) throw new UserError("That code expired. Log in again.", 401);
  if (!sec.safeEqual(row.code_hash, sec.hmac("code", String(code || "").trim()))) {
    await run("UPDATE login_codes SET tries=tries+1 WHERE id=?", [row.id]);
    throw new UserError("Wrong code.", 401);
  }
  await run("DELETE FROM login_codes WHERE id=?", [row.id]);
  await newSession(res);
  await logEvent("admin", "admin_login", { details: { ip: req.ip, twoStep: true } });
  res.json({ step: "done" });
}));
app.post("/api/admin/logout", wrap(async (req, res) => {
  const t = req.cookies[COOKIE];
  if (t) await run("DELETE FROM sessions WHERE token_hash=?", [sec.hmac("sess", t)]);
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
}));

const A = express.Router();
A.use(requireAdmin);

A.get("/me", wrap(async (req, res) => {
  const addr = await orders.receivingAddress();
  res.json({
    email: config.adminEmail, emailConfigured: email.configured(), productName: config.productName,
    settings: { btc_address: addr, sales_open: await getSetting("sales_open", "1"), auto_approve: await getSetting("auto_approve", "0") },
    addressValid: !!config.cashAppTag, cashAppTag: config.cashAppTag, confirmationsRequired: config.confirmationsRequired, publicUrl: config.publicUrl,
  });
}));

A.get("/orders", wrap(async (req, res) => {
  const rows = await all(`SELECT o.id, o.email, o.usd, o.sats, o.status, o.txid, o.received_sats, o.confirmations, o.review_reason,
      o.created_at, o.confirmed_at, o.approved_at, o.updated_at,
      l.id AS license_id, l.key_last4, l.status AS license_status, l.device_id, l.activated_at, l.last_seen_at, l.last_version
    FROM orders o LEFT JOIN licenses l ON l.order_id=o.id ORDER BY o.created_at DESC LIMIT 5000`);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const rel = await currentRelease(false);
  res.json({ rows: rows.map((r) => ({ ...r, btc: btc.satsToBtc(r.sats), received_btc: r.received_sats != null ? btc.satsToBtc(r.received_sats) : null, statusText: orders.STATUS_TEXT[r.status] })), counts, currentVersion: rel && rel.version });
}));

A.get("/order/:id", wrap(async (req, res) => {
  const o = await one("SELECT * FROM orders WHERE id=?", [req.params.id]);
  if (!o) throw new UserError("Order not found.", 404);
  const l = await one("SELECT id, key_last4, status, device_id, activated_at, last_seen_at, last_version, device_resets, expires_at, created_at FROM licenses WHERE order_id=?", [o.id]);
  const events = await all("SELECT * FROM events WHERE order_id=? ORDER BY id", [o.id]);
  const mails = await all("SELECT id, kind, status, tries, last_error, created_at, sent_at FROM outbox WHERE order_id=? ORDER BY id", [o.id]);
  const { view_token_hash, ...safe } = o;
  res.json({ order: { ...safe, btc: btc.satsToBtc(o.sats), received_btc: o.received_sats != null ? btc.satsToBtc(o.received_sats) : null, statusText: orders.STATUS_TEXT[o.status] },
    license: l, events, emails: mails, explorer: o.txid ? `https://mempool.space/tx/${o.txid}` : `https://mempool.space/address/${o.address}` });
}));
A.post("/order/:id/check", wrap(async (req, res) => {
  const o = await one("SELECT * FROM orders WHERE id=?", [req.params.id]);
  if (!o) throw new UserError("Order not found.", 404);
  try { await orders.checkOrder(o, "admin"); } catch (e) { if (e.user) throw e; throw new UserError("Couldn't reach the Bitcoin network. Try again shortly."); }
  res.json({ ok: true });
}));
A.post("/order/:id/approve", wrap(async (req, res) => {
  const b = req.body || {};
  const r = await orders.approveOrder(req.params.id, "admin", { force: !!b.force, note: b.note ? String(b.note).slice(0, 300) : null });
  res.json({ ok: true, already: !!r.already, key: r.key, emailed: !!(r.email && r.email.sent), emailConfigured: email.configured() });
}));
A.post("/order/:id/reject", wrap(async (req, res) => {
  await orders.rejectOrder(req.params.id, String((req.body && req.body.reason) || "").slice(0, 300));
  res.json({ ok: true });
}));
A.post("/order/:id/resend", wrap(async (req, res) => {
  const r = await orders.resend(req.params.id);
  res.json({ ok: true, sent: r.sent, configured: r.configured });
}));
A.post("/order/:id/reveal-key", wrap(async (req, res) => {
  const l = await one("SELECT * FROM licenses WHERE order_id=?", [req.params.id]);
  if (!l) throw new UserError("No license on this order yet.");
  await logEvent("admin", "license_key_viewed", { orderId: l.order_id, licenseId: l.id });
  res.json({ key: sec.decrypt(l.key_enc) });
}));
A.post("/license/:id/:action", wrap(async (req, res) => {
  const a = req.params.action;
  if (a === "reset-device") await orders.resetDevice(req.params.id);
  else if (a === "renew") {
    const l = await one("SELECT * FROM licenses WHERE id=?", [req.params.id]);
    if (!l) throw new UserError("License not found.", 404);
    const t = now();
    await run("UPDATE licenses SET expires_at=?, status='active', updated_at=? WHERE id=?", [Math.max(t, Number(l.expires_at || 0)) + 30 * 864e5, t, l.id]);
    await logEvent("admin", "license_renewed", { orderId: l.order_id, licenseId: l.id });
  } else await orders.setLicenseStatus(req.params.id, a);
  res.json({ ok: true });
}));

// releases (versions)
A.get("/releases", wrap(async (req, res) => {
  const rows = await all("SELECT id, version, notes, sha256, size, is_current, withdrawn, created_at FROM releases ORDER BY id DESC");
  const usage = await all("SELECT last_version AS version, COUNT(*) AS n FROM licenses WHERE last_version IS NOT NULL GROUP BY last_version");
  res.json({ rows, usage });
}));
A.post("/releases", express.raw({ type: "application/zip", limit: "6mb" }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new UserError("Choose a ZIP file to upload.");
  const top = await one("SELECT version FROM releases ORDER BY id DESC LIMIT 1");
  let v;
  try { v = pkg.validateRelease(req.body, top && top.version); } catch (e) { throw new UserError("Release not accepted: " + e.message); }
  const notes = decodeURIComponent(req.get("x-notes") || "").slice(0, 2000);
  const makeCurrent = req.get("x-make-current") === "1";
  const r = await run("INSERT INTO releases (version, notes, zip, sha256, size, is_current, created_at) VALUES (?,?,?,?,?,0,?)",
    [v.version, notes, req.body, v.sha256, req.body.length, now()]);
  const id = Number(r.lastInsertRowid);
  await logEvent("admin", "release_uploaded", { details: { version: v.version, sha256: v.sha256 } });
  if (makeCurrent) await makeReleaseCurrent(id);
  res.json({ ok: true, id, version: v.version });
}));
async function makeReleaseCurrent(id) {
  const r = await one("SELECT * FROM releases WHERE id=?", [id]);
  if (!r) throw new UserError("Release not found.", 404);
  if (r.withdrawn) throw new UserError("This release was withdrawn. Upload a fixed version instead.");
  await run("UPDATE releases SET is_current = CASE WHEN id=? THEN 1 ELSE 0 END", [id]);
  await logEvent("admin", "release_published", { details: { version: r.version } });
}
A.post("/releases/:id/current", wrap(async (req, res) => { await makeReleaseCurrent(+req.params.id); res.json({ ok: true }); }));
A.post("/releases/:id/withdraw", wrap(async (req, res) => {
  const r = await one("SELECT * FROM releases WHERE id=?", [+req.params.id]);
  if (!r) throw new UserError("Release not found.", 404);
  await run("UPDATE releases SET withdrawn=1, is_current=0 WHERE id=?", [r.id]);
  await logEvent("admin", "release_withdrawn", { details: { version: r.version } });
  // roll back: the newest release that isn't withdrawn becomes current again
  const prev = await one("SELECT id FROM releases WHERE withdrawn=0 ORDER BY id DESC LIMIT 1");
  if (prev && !(await one("SELECT 1 FROM releases WHERE is_current=1"))) await makeReleaseCurrent(prev.id);
  res.json({ ok: true });
}));
A.get("/releases/:id/test-download", wrap(async (req, res) => { // your own copy to test before publishing
  const r = await one("SELECT * FROM releases WHERE id=?", [+req.params.id]);
  if (!r) throw new UserError("Release not found.", 404);
  const out = pkg.buildCustomerZip(Buffer.from(r.zip), "");
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="TEST-${out.filename}"`, "Cache-Control": "no-store" });
  res.send(out.buf);
}));

A.get("/audit", wrap(async (req, res) => {
  res.json({ rows: await all("SELECT * FROM events ORDER BY id DESC LIMIT 1000") });
}));
A.post("/settings", wrap(async (req, res) => {
  const b = req.body || {};
  if (b.btc_address !== undefined) {
    const a = String(b.btc_address).trim();
    if (!btc.validAddress(a)) throw new UserError("That isn't a valid Bitcoin address. Copy it again from Cash App (Bitcoin → Receive). It usually starts with bc1.");
    await setSetting("btc_address", a);
    await logEvent("admin", "setting_btc_address", { details: { address: a } });
  }
  for (const k of ["sales_open", "auto_approve"]) if (b[k] !== undefined) {
    await setSetting(k, b[k] ? "1" : "0");
    await logEvent("admin", "setting_" + k, { details: { value: !!b[k] } });
  }
  res.json({ ok: true });
}));
A.post("/password", wrap(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!sec.checkPassword(String(current || ""), await adminPwHash())) throw new UserError("Your current password is wrong.");
  if (String(nw || "").length < 12) throw new UserError("Use at least 12 characters for the new password.");
  await setSetting("admin_pw_hash", sec.hashPassword(String(nw)));
  await run("DELETE FROM sessions"); // log out everywhere
  await logEvent("admin", "admin_password_changed");
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
}));
A.post("/emails/retry", wrap(async (req, res) => {
  await run("UPDATE outbox SET status='retry', tries=0 WHERE status='failed'");
  await email.retryPending();
  res.json({ ok: true });
}));
A.get("/backup", wrap(async (req, res) => { // everything except the release ZIPs (keep those yourself)
  const out = { exportedAt: new Date().toISOString(), note: "License keys are encrypted with SERVER_SECRET — keep that secret to restore." };
  for (const t of ["orders", "licenses", "events", "settings", "outbox"]) out[t] = await all(`SELECT * FROM ${t}`);
  out.releases = await all("SELECT id, version, notes, sha256, size, is_current, withdrawn, created_at FROM releases");
  await logEvent("admin", "backup_downloaded");
  res.set({ "Content-Disposition": `attachment; filename="polyrider-backup-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" });
  res.json(out);
}));
app.use("/api/admin", A);

// ===================================================================== pages
app.get(["/admin", "/admin/"], (req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(__dirname, "admin", "index.html")); });
app.use("/admin-assets", express.static(path.join(__dirname, "admin"), { index: false }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((req, res) => res.status(404).type("html").send(page("Page not found", "That page doesn't exist. <a href=\"/\">Go to the home page</a>.")));

// friendly errors only — never a stack trace
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "That file is too big." });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request." });
  if (err && err.user) return res.status(err.status || 400).json({ error: err.message });
  console.error(new Date().toISOString(), req.method, req.path, err);
  res.status(500).json({ error: "Something went wrong on our side. Please try again in a minute." });
});

// ===================================================================== background jobs
async function sweep() {
  const t = now();
  const list = await all(`SELECT * FROM orders WHERE
      (status='awaiting_payment') OR (status='payment_detected') OR
      (status='expired' AND quote_expires_at > ?) OR (status='requires_review' AND txid IS NOT NULL AND confirmations < ?)
      ORDER BY created_at DESC LIMIT 100`, [t - 24 * 3600e3, config.confirmationsRequired]);
  for (const o of list) {
    try { await orders.checkOrder(o, "system"); } catch (e) { if (!e.user) console.warn("check", o.id, e.message); }
  }
  await email.retryPending().catch(() => {});
  await run("DELETE FROM sessions WHERE expires_at < ?", [t]);
  await run("DELETE FROM login_codes WHERE expires_at < ?", [t]);
}

async function seedRelease() {
  if (await one("SELECT 1 FROM releases LIMIT 1")) return;
  const dir = path.join(__dirname, "release-seed");
  const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith(".zip"));
  if (!f) return;
  const buf = fs.readFileSync(path.join(dir, f));
  const v = pkg.validateRelease(buf, null);
  await run("INSERT INTO releases (version, notes, zip, sha256, size, is_current, created_at) VALUES (?,?,?,?,?,1,?)",
    [v.version, "First release", buf, v.sha256, buf.length, now()]);
  await logEvent("system", "release_seeded", { details: { version: v.version } });
}

async function start() {
  await dbm.init();
  await seedRelease();
  const server = app.listen(config.port, () => console.log(`${config.productName} store running on ${config.publicUrl} (port ${config.port})`));
  const every = +(process.env.SWEEP_SECONDS || 60) * 1000;
  setInterval(() => sweep().catch((e) => console.warn("sweep", e.message)), every).unref();
  return server;
}

if (require.main === module) start().catch((e) => { console.error("Startup failed:", e.message); process.exit(1); });
module.exports = { app, start, sweep };
