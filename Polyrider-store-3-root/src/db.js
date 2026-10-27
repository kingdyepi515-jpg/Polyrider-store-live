const { createClient } = require("@libsql/client");
const config = require("./config");

const db = createClient({ url: config.dbUrl, authToken: config.dbToken });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,               -- order number shown to people, e.g. PR-7K2M9QXA
    view_token_hash TEXT NOT NULL,     -- the private order-page link (only its hash is kept)
    email TEXT NOT NULL,
    usd REAL NOT NULL,
    btc_price REAL NOT NULL,
    sats INTEGER NOT NULL,             -- exact amount asked for (unique per open order)
    address TEXT NOT NULL,
    status TEXT NOT NULL,
    txid TEXT UNIQUE,
    received_sats INTEGER,
    confirmations INTEGER DEFAULT 0,
    review_reason TEXT,
    created_at INTEGER NOT NULL,
    quote_expires_at INTEGER NOT NULL,
    detected_at INTEGER,
    confirmed_at INTEGER,
    approved_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS orders_email ON orders(email)`,
  `CREATE INDEX IF NOT EXISTS orders_status ON orders(status)`,
  `CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),  -- one license per order, never two
    key_hash TEXT NOT NULL UNIQUE,     -- HMAC of the key, used to look it up
    key_enc TEXT NOT NULL,             -- encrypted copy, only so you can resend it
    key_last4 TEXT NOT NULL,
    status TEXT NOT NULL,              -- active | suspended | revoked
    device_id TEXT,
    activated_at INTEGER,
    last_seen_at INTEGER,
    last_version TEXT,
    device_resets INTEGER DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    notes TEXT,
    zip BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    is_current INTEGER DEFAULT 0,
    withdrawn INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,               -- admin | system | customer
    action TEXT NOT NULL,
    order_id TEXT,
    license_id TEXT,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS events_order ON events(order_id)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL, pending_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, tries INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL,
    html TEXT NOT NULL, text TEXT NOT NULL, kind TEXT, order_id TEXT,
    status TEXT NOT NULL, tries INTEGER DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
  )`,
];

async function init() {
  for (const s of SCHEMA) await db.execute(s);
  // Safe migration for databases created by earlier PolyRider builds.
  try { await db.execute("ALTER TABLE licenses ADD COLUMN expires_at INTEGER"); } catch (e) { if (!/duplicate column|already exists/i.test(e.message)) throw e; }
}

async function all(sql, args = []) { return (await db.execute({ sql, args })).rows; }
async function one(sql, args = []) { return (await all(sql, args))[0] || null; }
async function run(sql, args = []) { return db.execute({ sql, args }); }

async function getSetting(k, dflt = null) {
  const r = await one("SELECT v FROM settings WHERE k = ?", [k]);
  return r ? r.v : dflt;
}
async function setSetting(k, v) {
  await run("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, String(v)]);
}

async function logEvent(actor, action, { orderId = null, licenseId = null, details = null } = {}) {
  await run("INSERT INTO events (at, actor, action, order_id, license_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [Date.now(), actor, action, orderId, licenseId, details == null ? null : typeof details === "string" ? details : JSON.stringify(details)]);
}

module.exports = { db, init, all, one, run, getSetting, setSetting, logEvent };
