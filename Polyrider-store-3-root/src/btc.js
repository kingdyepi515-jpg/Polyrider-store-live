// Bitcoin helpers: price quote, address checking, and reading the public blockchain (mempool.space).
const crypto = require("crypto");
const config = require("./config");

async function getJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} from ${new URL(url).host}`); e.status = r.status; throw e; }
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t.trim(); }
}

// ---------- price ----------
let priceCache = { at: 0, usd: 0 };
async function btcUsd() {
  if (Date.now() - priceCache.at < 60000 && priceCache.usd) return priceCache.usd;
  const sources = config.priceApiOverride
    ? [async () => +(await getJson(config.priceApiOverride)).usd]
    : [
        async () => +(await getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot")).data.amount,
        async () => { const d = await getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"); return +d.result[Object.keys(d.result)[0]].c[0]; },
        async () => +(await getJson("https://www.bitstamp.net/api/v2/ticker/btcusd/")).last,
      ];
  const got = (await Promise.allSettled(sources.map((f) => f())))
    .filter((r) => r.status === "fulfilled" && isFinite(r.value) && r.value > 1000).map((r) => r.value).sort((a, b) => a - b);
  if (!got.length) throw new Error("Could not get the Bitcoin price right now. Please try again in a minute.");
  const usd = got[Math.floor(got.length / 2)];
  priceCache = { at: Date.now(), usd };
  return usd;
}

// ---------- address validation (checks the checksum so a typo can't slip through) ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58check(addr) {
  let n = 0n;
  for (const ch of addr) { const i = B58.indexOf(ch); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  const lead = addr.match(/^1*/)[0].length;
  bytes = Buffer.concat([Buffer.alloc(lead), bytes]);
  if (bytes.length !== 25) return false;
  const body = bytes.subarray(0, 21), sum = bytes.subarray(21);
  const h = crypto.createHash("sha256").update(crypto.createHash("sha256").update(body).digest()).digest();
  return h.subarray(0, 4).equals(sum) && (body[0] === 0x00 || body[0] === 0x05);
}
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
function bech32check(addr) {
  const a = addr.toLowerCase();
  if (addr !== a && addr !== addr.toUpperCase()) return false;
  const pos = a.lastIndexOf("1");
  if (a.slice(0, pos) !== "bc") return false;
  const data = [...a.slice(pos + 1)].map((c) => BECH.indexOf(c));
  if (data.some((d) => d < 0) || data.length < 7) return false;
  const hrp = [...a.slice(0, pos)];
  const exp = [...hrp.map((c) => c.charCodeAt(0) >> 5), 0, ...hrp.map((c) => c.charCodeAt(0) & 31)];
  const pm = polymod([...exp, ...data]);
  const ver = data[0];
  return (ver === 0 && pm === 1) || (ver >= 1 && pm === 0x2bc830a3);
}
function validAddress(addr) {
  if (typeof addr !== "string") return false;
  const a = addr.trim();
  if (/^bc1[a-z0-9]{8,87}$/i.test(a)) return bech32check(a) && (a.length === 42 || a.length === 62);
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return base58check(a);
  return false;
}

// ---------- blockchain ----------
const TXID_RE = /^[0-9a-f]{64}$/;
// short cache so many open orders don't hammer the public API
const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 500) cache.clear();
  return v;
}
const testing = () => process.env.NODE_ENV === "test";
async function tipHeight() { return cached("tip", testing() ? 0 : 20000, async () => +(await getJson(`${config.mempoolApi}/blocks/tip/height`))); }
async function getTx(txid) {
  try { return await getJson(`${config.mempoolApi}/tx/${txid}`); }
  catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }
}
async function addressTxs(address) { return cached("addr:" + address, testing() ? 0 : 20000, () => getJson(`${config.mempoolApi}/address/${address}/txs`)); }

// How much of a transaction went to our address, and how confirmed it is
function paidTo(tx, address, tip) {
  const sats = (tx.vout || []).filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
  const confirmed = !!(tx.status && tx.status.confirmed);
  const confs = confirmed && tip ? Math.max(1, tip - tx.status.block_height + 1) : 0;
  return { sats, confirmations: confs, blockTime: confirmed ? tx.status.block_time * 1000 : null };
}

const satsToBtc = (s) => (s / 1e8).toFixed(8);

module.exports = { btcUsd, validAddress, TXID_RE, tipHeight, getTx, addressTxs, paidTo, satsToBtc };
