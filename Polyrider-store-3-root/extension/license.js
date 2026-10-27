// PolyRider license check (background). Talks only to the PolyRider store server.
// It never touches your Polymarket account, bets or settings.
const SERVER = "__POLYRIDER_SERVER__";          // filled in automatically when you download
const PRESET_KEY = "__POLYRIDER_PRESET_KEY__";  // your key, filled in automatically when you download
const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_RECHECK_MIN = 60, DEFAULT_GRACE_H = 72;

const hasServer = () => /^https?:\/\//.test(SERVER);
const store = (o) => chrome.storage.local.set(o);
const load = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));

async function deviceId() {
  const { lic_device } = await load(["lic_device"]);
  if (lic_device) return lic_device;
  const id = crypto.randomUUID().replace(/-/g, "");
  await store({ lic_device: id });
  return id;
}

async function callServer(key) {
  if (!hasServer()) return { network: true, message: "This copy isn't connected to a store. Download it again from the store." };
  try {
    const r = await fetch(SERVER + "/api/license/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, deviceId: await deviceId(), version: VERSION }),
      signal: AbortSignal.timeout(60000), // the free server can take ~50s to wake up
      cache: "no-store",
    });
    const j = await r.json().catch(() => null);
    if (!j) return { network: true };
    return j;
  } catch (e) {
    return { network: true };
  }
}

// What the page should do right now
async function status(force) {
  const s = await load(["lic_key", "lic_state"]);
  let key = s.lic_key || (/^PR-/.test(PRESET_KEY) ? PRESET_KEY : "");
  if (!key) return { ok: false, need: "key", store: hasServer() ? SERVER : null };
  const st = s.lic_state || {};
  const recheckMs = (st.recheckMinutes || DEFAULT_RECHECK_MIN) * 60000;
  if (!force && st.ok && st.key === key && Date.now() - st.checkedAt < recheckMs) return { ...st, cached: true };

  const r = await callServer(key);
  if (r.network) {
    // server unreachable: keep working for a limited time after the last good check
    const graceMs = (st.offlineGraceHours || DEFAULT_GRACE_H) * 3600000;
    if (st.lastOkAt && st.key === key && Date.now() - st.lastOkAt < graceMs) {
      return { ...st, ok: true, offline: true, message: "License server unreachable — using your last check" };
    }
    return { ok: false, need: "server", key, message: r.message || "Can't reach the license server. Check your internet and try again.", store: hasServer() ? SERVER : null };
  }
  const next = {
    key, ok: !!r.ok, status: r.status, message: r.message, checkedAt: Date.now(),
    lastOkAt: r.ok ? Date.now() : null,
    recheckMinutes: r.recheckMinutes || DEFAULT_RECHECK_MIN, offlineGraceHours: r.offlineGraceHours || DEFAULT_GRACE_H,
    latest: r.latest || null, downloadPage: r.downloadPage || null, version: VERSION,
  };
  await store({ lic_key: key, lic_state: next });
  return r.ok ? next : { ...next, need: "key", store: hasServer() ? SERVER : null };
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("lic_")) return;
  (async () => {
    if (msg.type === "lic_status") return send(await status(!!msg.force));
    if (msg.type === "lic_activate") {
      const key = String(msg.key || "").trim().toUpperCase();
      if (!/^PR-?[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(key)) return send({ ok: false, need: "key", message: "A license key looks like PR-XXXX-XXXX-XXXX-XXXX." });
      await store({ lic_key: key, lic_state: {} });
      return send(await status(true));
    }
  })();
  return true;
});
