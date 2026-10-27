// PolyRider license gate. Loads before content.js. The trading panel only starts
// after the license server says this key is active on this computer.
(() => {
  if (window.__prGate) return;
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { ok: false, need: "server", message: "Extension is reloading — refresh this page." } : r)); }
    catch (_) { res({ ok: false, need: "server", message: "Extension was updated — refresh this page." }); }
  });
  const newer = (a, b) => { // is version a newer than b?
    const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
    return false;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CSS = `*{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
    .p{width:300px;background:#11151c;color:#e6e9ef;border:1px solid #2a3240;border-radius:10px;font-size:12px;box-shadow:0 6px 24px #0008}
    .h{padding:8px 10px;background:#1a202b;border-radius:10px 10px 0 0;font-weight:700;font-size:13px;display:flex;justify-content:space-between}
    .b{padding:10px}.k{color:#8a93a3}.e{color:#ff8a8a;margin-top:6px;min-height:14px}
    input{width:100%;background:#0b0e13;color:#fff;border:1px solid #3a4456;border-radius:6px;padding:7px 8px;font-size:13px;font-family:Menlo,Consolas,monospace;margin:8px 0;text-transform:uppercase}
    button{background:#1f9d55;color:#fff;border:0;border-radius:6px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer;width:100%}
    button:disabled{opacity:.6}a{color:#7fb3ff}.x{background:none;width:auto;padding:0 4px;color:#8a93a3}
    .u{width:300px;background:#1a2b1f;color:#d7f5df;border:1px solid #2f6b40;border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 6px 24px #0008;display:flex;gap:8px;align-items:center}`;

  function mount(pos) {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;${pos};z-index:2147483647;`;
    const sh = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    return { host, sh };
  }

  function keyPanel(st, start) {
    const { host, sh } = mount("left:12px;bottom:12px");
    const shop = st.store ? `${st.store}` : null;
    sh.innerHTML = `<style>${CSS}</style><div class="p"><div class="h">PolyRider BTC 5m <span class="k">license</span></div><div class="b">
      <div>Enter your license key to start PolyRider.</div>
      <input id="key" placeholder="PR-XXXX-XXXX-XXXX-XXXX" maxlength="30" autocomplete="off" spellcheck="false">
      <button id="go">Activate</button>
      <div class="e" id="msg">${esc(st.need === "key" && !st.message ? "" : st.message)}</div>
      ${shop ? `<div class="k" style="margin-top:6px">No key? <a href="${esc(shop)}" target="_blank" rel="noopener">Buy PolyRider</a> · <a href="${esc(shop)}/download.html" target="_blank" rel="noopener">Lost key</a></div>` : ""}
    </div></div>`;
    const $ = (id) => sh.getElementById(id);
    if (st.key) $("key").value = st.key;
    $("go").onclick = async () => {
      $("go").disabled = true; $("msg").style.color = "#8a93a3"; $("msg").textContent = "Checking… (can take up to a minute the first time)";
      const r = await ask({ type: "lic_activate", key: $("key").value });
      $("go").disabled = false;
      if (r && r.ok) { host.remove(); run(r, start); }
      else { $("msg").style.color = "#ff8a8a"; $("msg").textContent = (r && r.message) || "That key didn't work."; }
    };
    $("key").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });
  }

  function updateNotice(st) {
    const v = chrome.runtime.getManifest().version;
    if (!st.latest || !newer(st.latest.version, v) || sessionStorage.getItem("pr_upd_hide") === st.latest.version) return;
    const { host, sh } = mount("right:12px;bottom:12px");
    sh.innerHTML = `<style>${CSS}</style><div class="u"><div style="flex:1">PolyRider <b>v${esc(st.latest.version)}</b> is available (you have v${esc(v)}).
      <a href="${esc(st.downloadPage || "#")}" target="_blank" rel="noopener">Download update</a></div><button class="x" id="x">✕</button></div>`;
    sh.getElementById("x").onclick = () => { sessionStorage.setItem("pr_upd_hide", st.latest.version); host.remove(); };
  }

  let started = false;
  function run(st, start) {
    if (!started) { started = true; start(); }
    updateNotice(st);
    // re-check regularly; if the license was suspended/revoked, stop by reloading into the key screen.
    const every = Math.max(5, st.recheckMinutes || 60) * 60000;
    const timer = setInterval(async () => {
      const r = await ask({ type: "lic_status" });
      if (r && r.ok) return;
      if (r && r.need === "server") return; // network trouble: the background already applies the offline grace period
      clearInterval(timer);
      const waitSafe = () => { // don't reload during the betting part of a 5-minute window
        const into = (Date.now() % 300000) / 1000;
        if (into > 5 && into < 60) location.reload(); else setTimeout(waitSafe, 5000);
      };
      waitSafe();
    }, every);
  }

  window.__prGate = async (start) => {
    const st = await ask({ type: "lic_status" });
    if (st && st.ok) run(st, start);
    else keyPanel(st || {}, start);
  };
})();
