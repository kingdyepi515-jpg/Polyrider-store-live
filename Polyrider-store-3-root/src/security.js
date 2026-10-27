const crypto = require("crypto");
const config = require("./config");

const B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L to avoid typos (31 letters)

function randomString(len, alphabet = B32) {
  // rejection sampling so every character is equally likely
  let out = "";
  const max = 256 - (256 % alphabet.length);
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < max) out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// License key: PR-XXXX-XXXX-XXXX-XXXX  (16 random characters ≈ 79 bits)
function newLicenseKey() {
  const s = randomString(16);
  return `PR-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}
function normalizeKey(k) {
  const c = String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = c.startsWith("PR") ? c.slice(2) : c;
  if (body.length !== 16 || [...body].some((ch) => !B32.includes(ch))) return null;
  return `PR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}

const subKey = (label) => crypto.createHmac("sha256", config.serverSecret).update(label).digest();
const hmac = (label, value) => crypto.createHmac("sha256", subKey(label)).update(String(value)).digest("hex");
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", subKey("enc"), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".").map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", subKey("enc"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

// Signed, short-lived tokens (download links, recovery links)
function signToken(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  return body + "." + hmac("tok", body).slice(0, 43);
}
function verifyToken(token, kind) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = hmac("tok", body).slice(0, 43);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.k !== kind || !(p.exp > Date.now())) return null;
    return p;
  } catch { return null; }
}

// Passwords (scrypt, salted)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${h.toString("base64url")}`;
}
function checkPassword(pw, stored) {
  try {
    const [, salt, h] = String(stored).split("$");
    const want = Buffer.from(h, "base64url");
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, "base64url"), want.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Simple in-memory rate limiter (one server instance)
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
function blocked(key, max) { const b = buckets.get(key); return !!(b && Date.now() <= b.reset && b.n >= max); }
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    if (limited(`${name}:${req.ip}`, max, windowMs)) {
      return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
    }
    next();
  };
}
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (n > b.reset) buckets.delete(k); }, 60000).unref();

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
const validEmail = (e) => typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e.trim());

module.exports = {
  randomString, randomToken, newLicenseKey, normalizeKey, hmac, sha256, encrypt, decrypt,
  signToken, verifyToken, hashPassword, checkPassword, safeEqual, limited, blocked, rateLimit, validEmail,
};
