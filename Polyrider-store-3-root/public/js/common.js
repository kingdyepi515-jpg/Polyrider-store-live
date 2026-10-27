// shared helpers for the public pages
window.PR = (() => {
  async function api(path, body) {
    let r;
    try {
      r = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) { throw new Error("Can't reach the store right now. Check your internet connection and try again."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
    return j;
  }
  const $ = (id) => document.getElementById(id);
  function hashParams() {
    const p = new URLSearchParams(location.hash.slice(1));
    return Object.fromEntries(p.entries());
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
    if (btn) { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1500); }
  }
  let storeInfo = null;
  async function store() {
    if (!storeInfo) storeInfo = await api("/api/store");
    return storeInfo;
  }
  // fill support email + price anywhere on the page
  store().then((s) => {
    document.querySelectorAll("[data-price]").forEach((e) => (e.textContent = "$" + s.priceUsd.toFixed(2)));
    document.querySelectorAll("[data-support]").forEach((e) => {
      if (s.supportEmail) { e.innerHTML = ""; const a = document.createElement("a"); a.href = "mailto:" + s.supportEmail; a.textContent = s.supportEmail; e.appendChild(a); }
    });
    document.querySelectorAll("[data-version]").forEach((e) => (e.textContent = s.latestVersion ? "v" + s.latestVersion : ""));
  }).catch(() => {});
  return { api, $, hashParams, copy, store };
})();
