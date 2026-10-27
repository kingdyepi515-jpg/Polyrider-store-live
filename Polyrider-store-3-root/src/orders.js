// Orders, payment checking and licenses — the core business rules.
const config = require("./config");
const { all, one, run, getSetting, logEvent } = require("./db");
const sec = require("./security");
const btc = require("./btc");
const email = require("./email");

const ACTIVE_CHECK = ["awaiting_payment", "payment_detected", "expired", "requires_review"];
const STATUS_TEXT = {
  awaiting_payment: "Awaiting payment",
  payment_detected: "Payment detected — waiting for network confirmation",
  payment_confirmed: "Payment confirmed — waiting for seller approval",
  requires_review: "Payment requires review",
  approved: "Approved — license issued",
  expired: "Price quote expired",
  rejected: "Rejected",
};

const now = () => Date.now();
const orderUrl = (token) => `${config.publicUrl}/order.html#t=${token}`;

class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; this.user = true; } }

async function receivingAddress() {
  return (await getSetting("btc_address")) || config.btcAddress || "";
}
async function salesOpen() {
  return (await getSetting("sales_open", "1")) === "1";
}

// ---------- create ----------
async function createOrder(rawEmail, ip) {
  const emailAddr = String(rawEmail || "").trim().toLowerCase();
  if (!sec.validEmail(emailAddr)) throw new UserError("Please enter a valid email address.");
  if (!(await salesOpen())) throw new UserError("Sales are paused right now. Please check back soon.", 503);
  if (!config.cashAppTag) throw new UserError("The store is not ready to accept Cash App payments yet. Please check back soon.", 503);
  const open = await one("SELECT COUNT(*) AS n FROM orders WHERE email = ? AND status = 'awaiting_payment' AND quote_expires_at > ?", [emailAddr, now()]);
  if (open.n >= 3) throw new UserError("You already have unpaid orders open. Check your email or wait before starting another.");
  const id = "PR-" + sec.randomString(8);
  const viewToken = sec.randomToken(24);
  const t = now();
  const payUrl = `https://cash.app/$${encodeURIComponent(config.cashAppTag)}/${config.priceUsd.toFixed(2)}`;
  await run(`INSERT INTO orders (id, view_token_hash, email, usd, btc_price, sats, address, status, created_at, quote_expires_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, sec.hmac("view", viewToken), emailAddr, config.priceUsd, 0, 0, payUrl, "awaiting_payment", t, t + 48 * 3600e3, t]);
  await logEvent("customer", "order_created", { orderId: id, details: { usd: config.priceUsd, method: "cash_app_manual", ip } });
  email.send({ to: emailAddr, kind: "order", orderId: id, ...email.orderCreatedEmail({ orderId: id, orderUrl: orderUrl(viewToken), btc: "$" + config.priceUsd.toFixed(2), address: payUrl }) }).catch(() => {});
  return { id, viewToken };
}

const byToken = (token) => one("SELECT * FROM orders WHERE view_token_hash = ?", [sec.hmac("view", String(token || ""))]);

function publicView(o, lic) {
  return {
    id: o.id, email: o.email, status: o.status, statusText: STATUS_TEXT[o.status] || o.status,
    usd: o.usd, btc: btc.satsToBtc(o.sats), address: o.address,
    bip21: o.address, cashAppUrl: o.address, paymentMethod: "Cash App",
    quoteExpiresAt: o.quote_expires_at, createdAt: o.created_at,
    txid: o.txid, receivedBtc: o.received_sats != null ? btc.satsToBtc(o.received_sats) : null,
    confirmations: o.confirmations || 0, confirmationsRequired: config.confirmationsRequired,
    reviewReason: o.status === "requires_review" ? o.review_reason : null,
    licenseReady: !!(lic && o.status === "approved"),
  };
}

// ---------- payment checking ----------
async function findTxFor(o) {
  const tip = await btc.tipHeight();
  if (o.txid) {
    const tx = await btc.getTx(o.txid);
    return tx ? { tx, tip } : { tx: null, tip, missing: true };
  }
  const txs = await btc.addressTxs(o.address);
  for (const tx of Array.isArray(txs) ? txs : []) {
    const p = btc.paidTo(tx, o.address, tip);
    if (p.sats !== o.sats) continue; // auto-match only on the exact unique amount
    if (p.blockTime && p.blockTime < o.created_at - 10 * 60000) continue; // older than the order
    const used = await one("SELECT id FROM orders WHERE txid = ? AND id != ?", [tx.txid, o.id]);
    if (used) continue;
    return { tx, tip };
  }
  return { tx: null, tip };
}

// Look at the blockchain and move the order forward. Never issues a license by itself
// unless you switched on "auto-approve" in Settings.
async function checkOrder(o, actor = "system") {
  if (!ACTIVE_CHECK.includes(o.status)) return o;
  if (o.status === "expired" && now() - o.quote_expires_at > 7 * 864e5) return o;
  const t = now();
  const r = await findTxFor(o);
  if (!r.tx) {
    if (o.status === "awaiting_payment" && t > o.quote_expires_at) {
      await run("UPDATE orders SET status='expired', updated_at=? WHERE id=? AND status='awaiting_payment'", [t, o.id]);
      await logEvent("system", "quote_expired", { orderId: o.id });
    }
    return one("SELECT * FROM orders WHERE id=?", [o.id]);
  }
  const p = btc.paidTo(r.tx, o.address, r.tip);
  const reasons = [];
  let status;
  if (p.sats <= 0) {
    status = o.status === "requires_review" ? "requires_review" : o.status;
    reasons.push("The transaction did not send any bitcoin to this order's address.");
  } else {
    const paidAt = p.blockTime || t;
    const lateBy = o.detected_at ? 0 : paidAt - o.quote_expires_at;
    if (p.sats < o.sats) reasons.push(`Underpaid: received ${btc.satsToBtc(p.sats)} BTC, expected ${btc.satsToBtc(o.sats)} BTC.`);
    // Cash App's free "standard" bitcoin send can take hours, so a full payment that lands within 24h of the
    // quote is accepted (with a note). Later than that, the BTC price may have moved too much: you decide.
    if (lateBy > 24 * 3600e3) reasons.push("Paid more than 24 hours after the price quote expired — check that the amount still covers the price.");
    else if (lateBy > 15 * 60000) reasons.push(`Note: payment arrived ${Math.round(lateBy / 60000)} min after the quote expired (full BTC amount received).`);
    if (p.sats > o.sats * 1.05) reasons.push(`Overpaid: received ${btc.satsToBtc(p.sats)} BTC (expected ${btc.satsToBtc(o.sats)}).`);
    const blocking = reasons.some((x) => x.startsWith("Underpaid") || x.startsWith("Paid more than 24"));
    if (blocking) status = "requires_review";
    else if (p.confirmations < config.confirmationsRequired) status = "payment_detected";
    else status = "payment_confirmed";
  }
  try {
    await run(`UPDATE orders SET txid=?, received_sats=?, confirmations=?, status=?, review_reason=?,
               detected_at=COALESCE(detected_at, ?), confirmed_at=CASE WHEN ?='payment_confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
               updated_at=? WHERE id=? AND status IN ('awaiting_payment','payment_detected','expired','requires_review')`,
      [r.tx.txid, p.sats, p.confirmations, status, reasons.join(" ") || null, t, status, t, t, o.id]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new UserError("That transaction is already linked to a different order.");
    throw e;
  }
  if (status !== o.status || p.confirmations !== o.confirmations) {
    await logEvent(actor, "payment_" + status, { orderId: o.id, details: { txid: r.tx.txid, btc: btc.satsToBtc(p.sats), confirmations: p.confirmations, reasons } });
  }
  let fresh = await one("SELECT * FROM orders WHERE id=?", [o.id]);
  if (fresh.status === "payment_confirmed" && (await getSetting("auto_approve", "0")) === "1") {
    await approveOrder(fresh.id, "system");
    fresh = await one("SELECT * FROM orders WHERE id=?", [o.id]);
  }
  return fresh;
}

async function submitTxid(o, rawTxid) {
  const txid = String(rawTxid || "").trim().toLowerCase();
  if (!btc.TXID_RE.test(txid)) throw new UserError("That doesn't look like a Bitcoin transaction ID. It is 64 letters and numbers (0-9, a-f).");
  if (!ACTIVE_CHECK.includes(o.status)) throw new UserError("This order is no longer waiting for a payment.");
  if (o.txid && o.txid !== txid) throw new UserError("A transaction is already linked to this order. Contact support if it's wrong.");
  const used = await one("SELECT id FROM orders WHERE txid = ? AND id != ?", [txid, o.id]);
  if (used) throw new UserError("That transaction is already linked to a different order.");
  const tx = await btc.getTx(txid);
  if (!tx) throw new UserError("We can't find that transaction on the Bitcoin network. Make sure you sent bitcoin (BTC) on the Bitcoin network — not Lightning, BCH, or another coin — and copied the full ID. New transactions can take a minute to appear.");
  const p = btc.paidTo(tx, o.address, null);
  if (p.sats <= 0) throw new UserError("That transaction didn't send bitcoin to this order's address. Check that you used the address shown on this page.");
  await run("UPDATE orders SET txid=?, updated_at=? WHERE id=?", [txid, now(), o.id]);
  await logEvent("customer", "txid_submitted", { orderId: o.id, details: { txid } });
  return checkOrder({ ...o, txid }, "customer");
}

// ---------- approval + licenses ----------
async function approveOrder(orderId, actor = "admin", { force = false, note = null } = {}) {
  const o = await one("SELECT * FROM orders WHERE id=?", [orderId]);
  if (!o) throw new UserError("Order not found.", 404);
  const existing = await one("SELECT * FROM licenses WHERE order_id=?", [orderId]);
  if (existing) return { order: o, license: existing, key: sec.decrypt(existing.key_enc), already: true };
  const okStatuses = force ? ["payment_confirmed", "requires_review", "payment_detected", "awaiting_payment", "expired"] : ["payment_confirmed", "requires_review"];
  if (!okStatuses.includes(o.status)) {
    throw new UserError(o.status === "payment_detected" || o.status === "awaiting_payment" || o.status === "expired"
      ? "This payment isn't confirmed on the blockchain yet. Wait for confirmation, or use \"Approve anyway\" only if you've checked your wallet yourself."
      : `This order can't be approved (status: ${STATUS_TEXT[o.status] || o.status}).`);
  }
  const key = sec.newLicenseKey();
  const t = now();
  const licId = "L-" + sec.randomString(10);
  try {
    await run(`INSERT INTO licenses (id, order_id, key_hash, key_enc, key_last4, status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?, 'active', ?, ?, ?)`,
      [licId, orderId, sec.hmac("key", key), sec.encrypt(key), key.slice(-4), t + 30 * 864e5, t, t]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) { const l = await one("SELECT * FROM licenses WHERE order_id=?", [orderId]); return { order: o, license: l, key: sec.decrypt(l.key_enc), already: true }; }
    throw e;
  }
  await run("UPDATE orders SET status='approved', approved_at=?, updated_at=? WHERE id=?", [t, t, orderId]);
  await logEvent(actor, force ? "payment_approved_override" : "payment_approved", { orderId, licenseId: licId, details: { note, txid: o.txid } });
  await logEvent(actor, "license_issued", { orderId, licenseId: licId, details: { last4: key.slice(-4) } });
  const mail = await sendLicenseEmail(o, key);
  const license = await one("SELECT * FROM licenses WHERE id=?", [licId]);
  return { order: await one("SELECT * FROM orders WHERE id=?", [orderId]), license, key, email: mail };
}

async function sendLicenseEmail(o, key) {
  const msg = email.licenseEmail({
    orderId: o.id, key,
    downloadUrl: `${config.publicUrl}/download.html#e=${encodeURIComponent(o.email)}&k=${encodeURIComponent(key)}`,
    installUrl: `${config.publicUrl}/install.html`,
  });
  const r = await email.send({ to: o.email, kind: "license", orderId: o.id, ...msg });
  await logEvent("system", r.configured ? (r.sent ? "license_email_sent" : "license_email_queued_retry") : "license_email_not_configured", { orderId: o.id });
  return r;
}

async function rejectOrder(orderId, reason) {
  const o = await one("SELECT * FROM orders WHERE id=?", [orderId]);
  if (!o) throw new UserError("Order not found.", 404);
  if (o.status === "approved") throw new UserError("This order already has a license. Suspend or revoke the license instead.");
  await run("UPDATE orders SET status='rejected', review_reason=?, updated_at=? WHERE id=?", [reason || "Rejected by seller", now(), orderId]);
  await logEvent("admin", "order_rejected", { orderId, details: { reason } });
}

async function setLicenseStatus(licenseId, action) {
  const l = await one("SELECT * FROM licenses WHERE id=?", [licenseId]);
  if (!l) throw new UserError("License not found.", 404);
  if (l.status === "revoked") throw new UserError("This license was permanently revoked and can't be changed.");
  const next = { suspend: "suspended", reactivate: "active", revoke: "revoked" }[action];
  if (!next) throw new UserError("Unknown action.");
  if (action === "suspend" && l.status !== "active") throw new UserError("Only an active license can be suspended.");
  if (action === "reactivate" && l.status !== "suspended") throw new UserError("Only a suspended license can be reactivated.");
  await run("UPDATE licenses SET status=?, updated_at=? WHERE id=?", [next, now(), licenseId]);
  await logEvent("admin", "license_" + next, { orderId: l.order_id, licenseId });
}

async function resetDevice(licenseId) {
  const l = await one("SELECT * FROM licenses WHERE id=?", [licenseId]);
  if (!l) throw new UserError("License not found.", 404);
  await run("UPDATE licenses SET device_id=NULL, device_resets=device_resets+1, updated_at=? WHERE id=?", [now(), licenseId]);
  await logEvent("admin", "license_device_reset", { orderId: l.order_id, licenseId });
}

async function resend(orderId) {
  const o = await one("SELECT * FROM orders WHERE id=?", [orderId]);
  const l = o && (await one("SELECT * FROM licenses WHERE order_id=?", [orderId]));
  if (!l) throw new UserError("This order doesn't have a license yet.");
  if (l.status === "revoked") throw new UserError("This license is revoked.");
  const r = await sendLicenseEmail(o, sec.decrypt(l.key_enc));
  await logEvent("admin", "instructions_resent", { orderId, licenseId: l.id });
  return r;
}

// ---------- extension license check ----------
async function verifyLicense({ key, deviceId, version }) {
  const k = sec.normalizeKey(key);
  const dev = String(deviceId || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(dev)) throw new UserError("Bad request.");
  if (!k) return { ok: false, status: "invalid", message: "That license key isn't valid. Check it and try again." };
  const l = await one("SELECT * FROM licenses WHERE key_hash=?", [sec.hmac("key", k)]);
  if (!l) return { ok: false, status: "invalid", message: "That license key isn't valid. Check it and try again." };
  if (l.status === "revoked") return { ok: false, status: "revoked", message: "This license has been revoked. Contact the seller if you think this is a mistake." };
  if (l.status === "suspended") return { ok: false, status: "suspended", message: "This license is suspended. Contact the seller." };
  if (l.expires_at && Number(l.expires_at) < now()) return { ok: false, status: "expired", message: "This monthly license has expired. Contact the seller to renew it." };
  const t = now();
  const ver = String(version || "").slice(0, 20).replace(/[^0-9.]/g, "") || null;
  if (!l.device_id) {
    const r = await run("UPDATE licenses SET device_id=?, activated_at=COALESCE(activated_at, ?), last_seen_at=?, last_version=?, updated_at=? WHERE id=? AND device_id IS NULL",
      [dev, t, t, ver, t, l.id]);
    if (Number(r.rowsAffected) === 1) await logEvent("customer", "license_activated", { orderId: l.order_id, licenseId: l.id, details: { version: ver } });
    else return verifyLicense({ key, deviceId, version }); // someone else bound it at the same moment
  } else if (l.device_id !== dev) {
    // One active computer at a time. If the old install has been quiet for 24h (e.g. new computer or
    // re-installed in a new folder), move the license automatically — at most 3 times per 30 days.
    const quiet = !l.last_seen_at || t - l.last_seen_at > 24 * 3600e3;
    const moves = await one("SELECT COUNT(*) AS n FROM events WHERE license_id=? AND action='license_auto_moved' AND at>?", [l.id, t - 30 * 864e5]);
    if (quiet && moves.n < 3) {
      const r = await run("UPDATE licenses SET device_id=?, last_seen_at=?, last_version=?, updated_at=? WHERE id=? AND device_id=?", [dev, t, ver, t, l.id, l.device_id]);
      if (Number(r.rowsAffected) !== 1) return verifyLicense({ key, deviceId, version });
      await logEvent("system", "license_auto_moved", { orderId: l.order_id, licenseId: l.id, details: { version: ver } });
      return { ok: true, status: "active", message: "License moved to this computer" };
    }
    return { ok: false, status: "in_use", message: "This license is active on another computer. One license = one computer at a time. If you changed computers, try again after 24 hours, or contact the seller to move it now." };
  } else {
    await run("UPDATE licenses SET last_seen_at=?, last_version=? WHERE id=?", [t, ver, l.id]);
  }
  return { ok: true, status: "active", message: "License active" };
}

module.exports = {
  UserError, STATUS_TEXT, ACTIVE_CHECK, receivingAddress, salesOpen, orderUrl,
  createOrder, byToken, publicView, checkOrder, submitTxid,
  approveOrder, rejectOrder, setLicenseStatus, resetDevice, resend, verifyLicense,
};
