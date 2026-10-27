(() => {
  const $ = (id) => document.getElementById(id);
  // build elements safely (no innerHTML with customer data)
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  async function api(path, body, method) {
    const opts = { method: method || (body === undefined ? "GET" : "POST"), headers: { "x-requested-with": "polyrider-admin" }, cache: "no-store" };
    if (body instanceof Blob || body instanceof ArrayBuffer) { opts.body = body; opts.headers["content-type"] = "application/zip"; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
    let r;
    try { r = await fetch(path, opts); } catch { throw new Error("Can't reach the server. Check your internet."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.includes("/login")) { showLogin(); throw new Error("Please log in again."); }
    if (!r.ok) throw new Error(j.error || "Something went wrong.");
    return j;
  }
  const fmt = (t) => (t ? new Date(t).toLocaleString([], { year: "2-digit", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const ago = (t) => {
    if (!t) return "—";
    const s = (Date.now() - t) / 1000;
    return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 129600 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago";
  };
  const tag = (s, text) => h("span", { class: "tag t-" + s }, text || s);
  const say = (m) => alert(m);

  let me = null, rows = [], sort = { k: "created_at", dir: -1 };

  // ---------------------------------------------------------------- auth
  function showLogin() {
    document.querySelectorAll(".tab").forEach((t) => t.classList.add("hide"));
    $("nav").classList.add("hide"); $("banner").classList.add("hide");
    $("login").classList.remove("hide");
  }
  let pending = null;
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("lErr").textContent = ""; $("lBtn").disabled = true;
    try {
      const r = await api("/api/admin/login", { email: $("lEmail").value, password: $("lPw").value });
      if (r.step === "code") { pending = r.pending; $("loginForm").classList.add("hide"); $("codeForm").classList.remove("hide"); $("lCode").focus(); }
      else boot();
    } catch (err) { $("lErr").textContent = err.message; }
    $("lBtn").disabled = false; $("lPw").value = "";
  });
  $("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("lErr").textContent = "";
    try { await api("/api/admin/login/code", { pending, code: $("lCode").value }); boot(); }
    catch (err) { $("lErr").textContent = err.message; if (/expired/.test(err.message)) { $("codeForm").classList.add("hide"); $("loginForm").classList.remove("hide"); } }
  });
  $("logout").onclick = async (e) => { e.preventDefault(); await api("/api/admin/logout", {}).catch(() => {}); location.reload(); };

  async function boot() {
    try { me = await api("/api/admin/me"); } catch { return showLogin(); }
    $("login").classList.add("hide"); $("nav").classList.remove("hide");
    const warn = [];
    if (!me.addressValid) warn.push("No valid Bitcoin receiving address yet — customers can't buy. Add it in Settings.");
    if (!me.emailConfigured) warn.push("Email isn't set up: license keys won't be emailed. Copy them from each order and send them yourself, or set up email (see the setup guide).");
    if (me.settings.sales_open !== "1") warn.push("Sales are paused (Settings).");
    $("banner").textContent = warn.join(" "); $("banner").classList.toggle("hide", !warn.length);
    route();
  }
  window.addEventListener("hashchange", route);
  function route() {
    if (!me) return;
    const t = (location.hash.slice(1) || "orders").split("/")[0];
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hide", s.id !== "tab-" + t));
    document.querySelectorAll("nav a[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === t));
    ({ orders: loadOrders, versions: loadReleases, audit: loadAudit, settings: loadSettings }[t] || loadOrders)();
  }

  // ---------------------------------------------------------------- orders
  async function loadOrders() {
    try {
      const r = await api("/api/admin/orders");
      rows = r.rows;
      const c = r.counts;
      const todo = (c.payment_confirmed || 0) + (c.requires_review || 0);
      $("stats").replaceChildren(
        stat("Needs my attention", todo, "todo", todo > 0),
        stat("Awaiting payment", c.awaiting_payment || 0, "awaiting_payment"),
        stat("Payment detected", c.payment_detected || 0, "payment_detected"),
        stat("Approved (sold)", c.approved || 0, "approved"),
        stat("Current version", r.currentVersion ? "v" + r.currentVersion : "none", null),
      );
      drawOrders();
    } catch (e) { say(e.message); }
  }
  function stat(label, n, filter, hot) {
    return h("div", { class: "stat" + (hot ? " hot" : ""), onclick: () => { if (filter) { $("fStatus").value = filter; drawOrders(); } } }, h("b", {}, n), h("span", {}, label));
  }
  function drawOrders() {
    const q = $("q").value.trim().toLowerCase(), f = $("fStatus").value;
    let list = rows.filter((r) => {
      if (f === "todo" && !["payment_confirmed", "requires_review"].includes(r.status)) return false;
      if (f.startsWith("lic_") && r.license_status !== f.slice(4)) return false;
      if (f && f !== "todo" && !f.startsWith("lic_") && r.status !== f) return false;
      if (!q) return true;
      return [r.email, r.id, r.txid, r.key_last4, r.license_id].some((x) => x && String(x).toLowerCase().includes(q));
    });
    list.sort((a, b) => { const x = a[sort.k] ?? "", y = b[sort.k] ?? ""; return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
    document.querySelectorAll("#ordersTbl th[data-sort]").forEach((th) => th.className = th.dataset.sort === sort.k ? (sort.dir > 0 ? "asc" : "desc") : "");
    $("ordersTbl").tBodies[0].replaceChildren(...list.map((r) => h("tr", { onclick: () => openOrder(r.id) },
      h("td", {}, fmt(r.created_at)),
      h("td", { class: "mono" }, r.id),
      h("td", {}, r.email),
      h("td", {}, `$${(+r.usd).toFixed(2)}`, h("div", { class: "small mono" }, r.btc + " BTC")),
      h("td", {}, "Bitcoin"),
      h("td", { class: "mono" }, r.txid ? r.txid.slice(0, 10) + "…" : "—", r.txid ? h("div", { class: "small" }, `${r.received_btc} BTC · ${r.confirmations} conf`) : null),
      h("td", {}, tag(r.status, r.statusText)),
      h("td", {}, r.license_status ? [tag(r.license_status), h("div", { class: "small mono" }, "…" + r.key_last4)] : "—"),
      h("td", {}, r.license_status ? (r.device_id ? "Activated " + fmt(r.activated_at) : "Not activated") : "—"),
      h("td", {}, r.last_version ? "v" + r.last_version : "—"),
      h("td", {}, ago(r.last_seen_at)),
    )));
    $("ordersCount").textContent = `${list.length} of ${rows.length} orders`;
  }
  $("q").addEventListener("input", drawOrders);
  $("fStatus").addEventListener("change", drawOrders);
  $("reload").onclick = loadOrders;
  document.querySelectorAll("#ordersTbl th[data-sort]").forEach((th) => th.onclick = () => {
    sort = { k: th.dataset.sort, dir: sort.k === th.dataset.sort ? -sort.dir : -1 }; drawOrders();
  });

  // ---------------------------------------------------------------- order drawer
  async function openOrder(id) {
    $("drawer").classList.remove("hide");
    $("dBody").replaceChildren(h("p", {}, "Loading…"));
    try { drawOrder(await api("/api/admin/order/" + encodeURIComponent(id))); }
    catch (e) { $("dBody").replaceChildren(h("p", { class: "err" }, e.message)); }
  }
  $("dClose").onclick = () => { $("drawer").classList.add("hide"); loadOrders(); };
  $("drawer").addEventListener("click", (e) => { if (e.target === $("drawer")) $("dClose").click(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").classList.contains("hide")) $("dClose").click(); });

  async function act(label, fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try { const r = await fn(); return r; } catch (e) { say(e.message); }
  }

  function drawOrder(d) {
    const o = d.order, l = d.license;
    const id = o.id;
    const refresh = () => openOrder(id);
    const kv = (pairs) => h("dl", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
    const parts = [];
    parts.push(h("h2", { class: "mono" }, id), h("div", {}, tag(o.status, o.statusText)));
    if (o.review_reason) parts.push(h("div", { class: "warn", style: "margin-top:10px" }, o.review_reason));

    parts.push(h("h3", {}, "Customer & payment"), kv([
      ["Email", o.email],
      ["Price", `$${(+o.usd).toFixed(2)} at $${Math.round(o.btc_price).toLocaleString()}/BTC`],
      ["Amount asked", h("span", { class: "mono" }, o.btc + " BTC")],
      ["Paid to", h("span", { class: "mono" }, o.address)],
      ["Transaction", o.txid ? h("span", { class: "mono" }, o.txid) : "none yet"],
      ["Received", o.received_btc ? `${o.received_btc} BTC · ${o.confirmations} confirmation(s) (need ${me.confirmationsRequired})` : "—"],
      ["Ordered", fmt(o.created_at)], ["Quote expired/expires", fmt(o.quote_expires_at)],
      ["Payment confirmed", fmt(o.confirmed_at)], ["Approved", fmt(o.approved_at)],
    ]), h("p", {}, h("a", { href: d.explorer, target: "_blank", rel: "noopener noreferrer" }, "Open on mempool.space (blockchain) ↗")));

    const pa = [];
    if (o.status !== "approved" && o.status !== "rejected") {
      pa.push(h("button", { class: "btn btn-o", onclick: async () => { await act("check", () => api(`/api/admin/order/${id}/check`, {})); refresh(); } }, "Check blockchain now"));
    }
    if (["payment_confirmed", "requires_review"].includes(o.status)) {
      pa.push(h("button", { class: "btn btn-g", onclick: async () => {
        const msg = o.status === "requires_review"
          ? `This payment needs review:\n\n${o.review_reason}\n\nApprove it anyway and issue a license to ${o.email}?`
          : `Approve payment of ${o.received_btc} BTC and issue a license to ${o.email}?`;
        const r = await act("approve", () => api(`/api/admin/order/${id}/approve`, {}), msg);
        if (r) say(r.emailed ? "Approved. License key emailed to the customer." : `Approved. Email ${r.emailConfigured ? "will retry automatically" : "is not set up"} — copy this key and send it to the customer:\n\n${r.key}`);
        refresh();
      } }, "Approve payment & issue license"));
    }
    if (["awaiting_payment", "payment_detected", "expired"].includes(o.status)) {
      pa.push(h("button", { class: "btn btn-o", onclick: async () => {
        const note = prompt("Approve WITHOUT blockchain confirmation?\nOnly do this if you checked your Cash App and the money really arrived.\n\nType a short note (e.g. 'seen in Cash App 0.00045 BTC'):");
        if (!note) return;
        const r = await act("force", () => api(`/api/admin/order/${id}/approve`, { force: true, note }));
        if (r) say(r.emailed ? "Approved. License key emailed." : `Approved. Copy this key for the customer:\n\n${r.key}`);
        refresh();
      } }, "Approve anyway (checked myself)"));
    }
    if (o.status !== "approved" && o.status !== "rejected") {
      pa.push(h("button", { class: "btn btn-o", onclick: async () => {
        const reason = prompt("Reject this order? Type the reason (the customer sees it):"); if (!reason) return;
        await act("reject", () => api(`/api/admin/order/${id}/reject`, { reason })); refresh();
      } }, "Reject"));
    }
    if (pa.length) parts.push(h("div", { class: "actions" }, pa));

    parts.push(h("h3", {}, "License"));
    if (!l) parts.push(h("p", { class: "small" }, "No license yet — it's created when you approve the payment."));
    else {
      const keyBox = h("div", { class: "keybox" }, "PR-••••-••••-••••-" + l.key_last4);
      parts.push(keyBox, kv([
        ["Status", tag(l.status)],
        ["Activation", l.device_id ? `Activated ${fmt(l.activated_at)} (one computer)` : "Not activated yet"],
        ["Version in use", l.last_version ? "v" + l.last_version : "—"],
        ["Last activity", `${ago(l.last_seen_at)}${l.last_seen_at ? " (" + fmt(l.last_seen_at) + ")" : ""}`],
        ["Computer resets", l.device_resets || 0],
        ["License expires", l.expires_at ? fmt(l.expires_at) : "—"],
      ]));
      const la = [
        h("button", { class: "btn btn-o", onclick: async () => { if (confirm("Renew this license for 30 days? Confirm you received the $29.99 renewal payment in Cash App.")) { await act("renew", () => api(`/api/admin/license/${l.id}/renew`, {})); refresh(); } } }, "Renew 30 days"),
        h("button", { class: "btn btn-o", onclick: async (e) => {
          const r = await act("reveal", () => api(`/api/admin/order/${id}/reveal-key`, {}));
          if (r) { keyBox.textContent = r.key; e.target.textContent = "Copy key"; e.target.onclick = () => navigator.clipboard.writeText(r.key).then(() => (e.target.textContent = "Copied ✓")); }
        } }, "Show key"),
      ];
      if (l.status !== "revoked") la.push(h("button", { class: "btn btn-o", onclick: async () => {
        const r = await act("resend", () => api(`/api/admin/order/${id}/resend`, {}), `Email the license key and install instructions to ${o.email} again?`);
        if (r) say(r.configured ? (r.sent ? "Sent." : "Couldn't send yet — it will retry automatically.") : "Email isn't set up. Use Show key and send it yourself.");
        refresh();
      } }, "Resend email"));
      if (l.status === "active") la.push(h("button", { class: "btn btn-o", onclick: async () => {
        await act("reset", () => api(`/api/admin/license/${l.id}/reset-device`, {}), "Free this license so it can be activated on a different computer? The first computer that checks in next takes it — make sure the customer has PolyRider closed on the old computer.");
        refresh();
      } }, "Move to new computer"));
      if (l.status === "active") la.push(h("button", { class: "btn btn-o", onclick: async () => {
        await act("suspend", () => api(`/api/admin/license/${l.id}/suspend`, {}), `Suspend ${o.email}'s license? PolyRider stops on their computer at its next license check (within about an hour). You can reactivate later.`);
        refresh();
      } }, "Suspend"));
      if (l.status === "suspended") la.push(h("button", { class: "btn btn-g", onclick: async () => {
        await act("reactivate", () => api(`/api/admin/license/${l.id}/reactivate`, {}), `Reactivate ${o.email}'s license?`);
        refresh();
      } }, "Reactivate"));
      if (l.status !== "revoked") la.push(h("button", { class: "btn btn-r", onclick: async () => {
        const t = prompt(`PERMANENTLY revoke ${o.email}'s license? This can't be undone.\nType REVOKE to confirm:`);
        if (t !== "REVOKE") return;
        await act("revoke", () => api(`/api/admin/license/${l.id}/revoke`, {})); refresh();
      } }, "Revoke forever"));
      parts.push(h("div", { class: "actions" }, la));
    }

    if (d.emails.length) {
      parts.push(h("h3", {}, "Emails"), h("ul", { class: "timeline" }, d.emails.map((m) =>
        h("li", {}, h("span", { class: "when" }, fmt(m.created_at)), " ", m.kind, " — ", tag(m.status === "sent" ? "approved" : m.status === "failed" ? "revoked" : "awaiting_payment", m.status), m.last_error ? h("div", { class: "small" }, m.last_error) : null))));
    }
    parts.push(h("h3", {}, "History"), h("ul", { class: "timeline" }, d.events.map((ev) =>
      h("li", {}, h("span", { class: "when" }, fmt(ev.at)), " ", h("b", {}, ev.action.replace(/_/g, " ")), ` (${ev.actor})`, ev.details ? h("div", { class: "small mono" }, ev.details) : null))));
    $("dBody").replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- versions
  async function loadReleases() {
    try {
      const r = await api("/api/admin/releases");
      const use = Object.fromEntries(r.usage.map((u) => [u.version, u.n]));
      $("relTbl").tBodies[0].replaceChildren(...r.rows.map((x) => h("tr", {},
        h("td", { class: "mono" }, "v" + x.version),
        h("td", {}, fmt(x.created_at)),
        h("td", { class: "wrap" }, x.notes || "—"),
        h("td", {}, x.withdrawn ? tag("revoked", "withdrawn") : x.is_current ? tag("active", "current") : tag("expired", "not current")),
        h("td", {}, use[x.version] || 0),
        h("td", {}, h("div", { class: "actions", style: "margin:0" },
          h("a", { class: "btn btn-o", href: `/api/admin/releases/${x.id}/test-download` }, "Test download"),
          !x.is_current && !x.withdrawn ? h("button", { class: "btn btn-g", onclick: async () => { await act("cur", () => api(`/api/admin/releases/${x.id}/current`, {}), `Make v${x.version} the version customers download? Did you test it?`); loadReleases(); } }, "Make current") : null,
          !x.withdrawn ? h("button", { class: "btn btn-r", onclick: async () => { await act("wd", () => api(`/api/admin/releases/${x.id}/withdraw`, {}), `Withdraw v${x.version}? Customers can no longer download it; the previous version becomes current.`); loadReleases(); } }, "Withdraw") : null,
        )),
      )));
    } catch (e) { say(e.message); }
  }
  $("relForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("relErr").textContent = "";
    const f = $("relFile").files[0];
    if (!f) { $("relErr").textContent = "Choose a ZIP file."; return; }
    try {
      const res = await fetch("/api/admin/releases", { method: "POST", body: f, headers: {
        "x-requested-with": "polyrider-admin", "content-type": "application/zip",
        "x-notes": encodeURIComponent($("relNotes").value), "x-make-current": $("relCurrent").checked ? "1" : "0" } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Upload failed.");
      say(`Uploaded v${j.version}.` + ($("relCurrent").checked ? " It is now the current version." : " Test it, then press Make current."));
      $("relForm").reset(); loadReleases();
    } catch (err) { $("relErr").textContent = err.message; }
  });

  // ---------------------------------------------------------------- audit
  let audit = [];
  async function loadAudit() {
    try { audit = (await api("/api/admin/audit")).rows; drawAudit(); } catch (e) { say(e.message); }
  }
  function drawAudit() {
    const q = $("aq").value.toLowerCase();
    $("auditTbl").tBodies[0].replaceChildren(...audit.filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q)).map((a) => h("tr", { onclick: () => a.order_id && openOrder(a.order_id) },
      h("td", {}, fmt(a.at)), h("td", {}, a.actor), h("td", {}, a.action.replace(/_/g, " ")), h("td", { class: "mono" }, a.order_id || "—"), h("td", { class: "wrap small mono" }, a.details || ""))));
  }
  $("aq").addEventListener("input", drawAudit);

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    me = await api("/api/admin/me");
    $("sAddr").value = me.settings.btc_address || "";
    $("sOpen").checked = me.settings.sales_open === "1";
    $("sAuto").checked = me.settings.auto_approve === "1";
    $("sConf").textContent = me.confirmationsRequired;
    $("sEmail").textContent = me.emailConfigured ? "Email is set up. License keys are emailed automatically when you approve." : "Email is NOT set up. Approve still works — copy the key from the order and send it yourself. See the setup guide to turn email on (free).";
  }
  $("sAddrSave").onclick = async () => {
    $("sAddrErr").textContent = "";
    const a = $("sAddr").value.trim();
    if (!confirm(`Save this as your receiving address?\n\n${a}\n\nCheck it carefully against Cash App — payments sent to a wrong address are lost.`)) return;
    try { await api("/api/admin/settings", { btc_address: a }); say("Saved. New orders will use this address."); boot(); }
    catch (e) { $("sAddrErr").textContent = e.message; }
  };
  $("sOpen").onchange = async (e) => { await act("open", () => api("/api/admin/settings", { sales_open: e.target.checked })); boot(); };
  $("sAuto").onchange = async (e) => {
    if (e.target.checked && !confirm("With auto-approve ON, a license is issued automatically once the payment is confirmed on the blockchain with the correct amount — without you pressing Approve. Turn it on?")) { e.target.checked = false; return; }
    await act("auto", () => api("/api/admin/settings", { auto_approve: e.target.checked }));
  };
  $("sRetry").onclick = async () => { await act("retry", () => api("/api/admin/emails/retry", {})); say("Retried."); };
  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("pwErr").textContent = "";
    try { await api("/api/admin/password", { current: $("pwCur").value, next: $("pwNew").value }); say("Password changed. Log in again."); location.reload(); }
    catch (err) { $("pwErr").textContent = err.message; }
  });

  boot();
})();
