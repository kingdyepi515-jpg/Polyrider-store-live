// PolyRider BTC 5m — simple goal trader for Polymarket US "BTC Up or Down 5m".
// You set the bet $ and your goal in cents. In the last 2 minutes it bets the side
// whose win pays your goal or less (the safer, more expensive side).
(() => {
  if (window.__polyrider) return;
  window.__polyrider = true;

  const VER = "4.2.0";
  const API = "https://web.polymarket.us/gateway.events.v1.EventsService/GetEventBySlug";
  const DEF = { v: 5, auto: true, amount: 2, goal: 10, lastSec: 120, minLeft: 4 };

  let S = { ...DEF };
  let D = { day: "", pnl: 0, w: 0, l: 0, trades: 0, lastSlug: "", pending: [], log: [], ledger: null, unconf: null, dayCash: null };
  const live = { mkt: null, mktTs: 0, busy: false, staleSince: 0, status: "starting…" };

  const today = () => new Date().toLocaleDateString("en-CA");
  const save = () => chrome.storage.local.set({ pr_set: S, pr_day: D });
  function log(t) {
    D.log.unshift(new Date().toLocaleTimeString() + " " + t);
    D.log = D.log.slice(0, 40); save(); drawLog();
  }

  // ---------- time / slug ----------
  const winStart = (ms = Date.now()) => Math.floor(ms / 300000) * 300000;
  const p2 = (n) => String(n).padStart(2, "0");
  function slugFor(ms) {
    const d = new Date(winStart(ms));
    return `btc-updown-5m-${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}z`;
  }
  const pageSlug = () => (location.pathname.match(/\/event\/(btc-updown-5m-[\w-]+)/) || [])[1] || "";

  // ---------- data ----------
  async function getEvent(slug) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(API, {
      signal: ac.signal, cache: "no-store",
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({ slug }),
    });
    clearTimeout(to);
    if (!r.ok) throw new Error("event " + r.status);
    const e = (await r.json()).event;
    const m = e.markets[0];
    const t = m.assetPriceTerms || {};
    const num = (q) => (q && q.value != null ? +q.value : null);
    let op = [];
    try { op = JSON.parse(m.outcomePrices || "[]").map(Number); } catch (_) {}
    return {
      slug,
      start: Date.parse(t.windowStart || e.startDate),
      end: Date.parse(t.windowEnd || e.endDate),
      ptb: num(t.priceToBeat),
      settle: num(t.settlementPrice),
      bid: num(m.bestBidQuote),
      ask: num(m.bestAskQuote),
      resolved: /RESOLVED/.test(m.status || "") || !!e.closed,
      op,
    };
  }
  // the Up / Down % exactly as the page shows them
  function domPrices() {
    const bs = [...document.querySelectorAll("button[aria-checked]")].filter((b) => b.getBoundingClientRect().width > 0);
    const get = (side) => {
      for (const b of bs) {
        const t = (b.innerText || "").replace(/\s+/g, " ").trim();
        const m = t.match(new RegExp("^" + side + "\\s*(\\d{1,3})\\s*[%¢]"));
        if (m) return +m[1] / 100;
      }
      return null;
    };
    return { up: get("Up"), dn: get("Down") };
  }

  // ---------- your real balance (the "Cash" number in Polymarket's header) ----------
  function cashNow() {
    for (const e of document.querySelectorAll("div,span,dt,p")) {
      if (e.children.length || !/^Cash$/i.test((e.textContent || "").trim())) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || r.top > 150) continue;
      const m = (e.parentElement.innerText || "").replace(/,/g, "").match(/\$\s*(\d+(?:\.\d+)?)/);
      if (m) return +m[1];
    }
    return null;
  }
  const r2 = (x) => Math.round(x * 100) / 100;

  // ---------- page clicking ----------
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function tradeBox() {
    const inp = [...document.querySelectorAll("input.pk-currency-input__input")].find(vis);
    if (!inp) return null;
    let box = inp;
    for (let i = 0; i < 12 && box; i++) {
      box = box.parentElement;
      if (!box || !box.querySelector('button[type="submit"]')) continue;
      const bs = [...box.querySelectorAll("button")].map(txt);
      if (bs.some((t) => /^Up\b/.test(t)) && bs.some((t) => /^Down\b/.test(t))) return { box, inp };
    }
    return null;
  }
  function fire(el) {
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  }
  const val = (inp) => parseFloat(String(inp.value).replace(/[^\d.]/g, ""));
  function setInput(inp, v) {
    const set = (x) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, x);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    };
    inp.focus();
    set(""); // clear first so nothing gets added to an old amount
    set(String(v));
    if (val(inp) !== +v) { inp.select(); document.execCommand("delete"); document.execCommand("insertText", false, String(v)); }
    return val(inp) === +v;
  }
  async function placeOrder(side, amt) {
    const tb = tradeBox();
    if (!tb) return { ok: false, why: "trade box not found" };
    const { box, inp } = tb;
    const btns = () => [...box.querySelectorAll("button")].filter(vis);
    const buyTab = btns().find((b) => b.hasAttribute("aria-selected") && txt(b) === "Buy");
    if (buyTab && buyTab.getAttribute("aria-selected") !== "true") { fire(buyTab); await sleep(250); }
    const sideBtn = btns().find((b) => b.hasAttribute("aria-checked") && new RegExp("^" + side + "\\b").test(txt(b)));
    if (!sideBtn) return { ok: false, why: side + " button not found" };
    if (sideBtn.getAttribute("aria-checked") !== "true") { fire(sideBtn); await sleep(250); }
    if (!setInput(inp, amt)) { await sleep(150); if (!setInput(inp, amt)) return { ok: false, why: "amount box didn't take $" + amt }; }
    await sleep(300);
    if (val(inp) !== +amt) return { ok: false, why: `amount box shows $${val(inp)}, not $${amt} — not betting` }; // last check before Buy
    const sub = box.querySelector('button[type="submit"]');
    if (!sub || !vis(sub)) return { ok: false, why: "buy button not found" };
    if (/log ?in|sign ?up/i.test(txt(sub) + " " + (sub.getAttribute("aria-label") || ""))) return { ok: false, why: "not logged in" };
    if (sub.disabled || sub.getAttribute("aria-disabled") === "true") return { ok: false, why: "buy button disabled" };
    const msgs = () => [...document.querySelectorAll('[role="alert"],[role="status"],[data-sonner-toast],[class*="toast" i]')].map(txt).join(" | ") + " | " + txt(box);
    const before = msgs();
    const cash0 = cashNow();
    if (cash0 == null) return { ok: false, why: "can't read your Cash balance on the page — not betting" };
    if (cash0 < amt) return { ok: false, why: `Cash $${cash0} is less than the bet $${amt}` };
    fire(sub);
    for (let i = 0; i < 12; i++) { // confirm window, if the site shows one
      await sleep(200);
      const dlg = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(vis).pop();
      if (dlg) {
        const c = [...dlg.querySelectorAll("button")].filter(vis).find((b) => /confirm|place|^buy|submit/i.test(txt(b)) && !b.disabled);
        if (c) { fire(c); break; }
      }
    }
    await sleep(900);
    // only look at new messages from the trade box / pop-ups (not the chat)
    const now = msgs();
    const err = now !== before && now.match(/(insufficient[^|]{0,60}|order (failed|rejected)[^|]{0,60}|something went wrong[^|]{0,40})/i);
    if (err) return { ok: false, clicked: true, why: err[0] };
    // REAL check: the bet only counts if your Cash balance actually went down
    for (let i = 0; i < 40; i++) {
      const c = cashNow();
      if (c != null && cash0 - c >= amt * 0.5) return { ok: true, cost: r2(cash0 - c), cash0, cash1: c };
      await sleep(250);
    }
    return { ok: false, clicked: true, cash0, why: `balance didn't change (still $${cashNow() ?? "?"}) — the order did NOT go through` };
  }

  // ---------- prices ----------
  function view() {
    const m = live.mkt;
    if (!m) return null;
    const left = (m.end - Date.now()) / 1000;
    let upP = m.ask, dnP = m.bid != null ? +(1 - m.bid).toFixed(2) : null; // what it costs to buy each side
    // live price comes from Polymarket's server every second; the page's own numbers can get stuck
    const apiFresh = Date.now() - live.mktTs < 3000 && upP != null;
    if (pageSlug() === m.slug) {
      const dp = domPrices();
      if (!apiFresh) { if (dp.up != null) upP = dp.up; if (dp.dn != null) dnP = dp.dn; }
      else if (dp.up != null && Math.abs(dp.up - upP) >= 0.05) live.staleSince = live.staleSince || Date.now();
      else live.staleSince = 0;
    }
    const a = +S.amount;
    const win = (p) => (p != null && p > 0 && p < 1 ? a / p - a : null); // what a win pays on top of the bet
    return { m, left, upP, dnP, upWin: win(upP), dnWin: win(dnP) };
  }
  const cents = (x) => (x == null ? "–" : x >= 1 ? "$" + x.toFixed(2) : Math.round(x * 100) + "¢");

  function decide(v) {
    if (!v) return { act: false, why: "loading market…" };
    if (v.m.resolved) return { act: false, why: "this 5 min is closed" };
    if (D.lastSlug === v.m.slug) return { act: false, why: "already bet this 5 min ✔" };
    if (v.left < S.minLeft) return { act: false, why: "too late to bet" };
    const goal = S.goal / 100;
    const ok = [["Up", v.upP, v.upWin], ["Down", v.dnP, v.dnWin]].filter(([, p, w]) => w != null && w > 0.0001 && w <= goal + 1e-9);
    if (v.left > S.lastSec) {
      const s = Math.ceil(v.left - S.lastSec);
      return { act: false, why: `watching — betting starts in ${Math.floor(s / 60)}:${p2(s % 60)}` + (ok.length ? ` (${ok[0][0]} pays ${cents(ok[0][2])} now)` : "") };
    }
    if (!ok.length) return { act: false, why: `waiting for a side paying ${S.goal}¢ or less (Up pays ${cents(v.upWin)} · Down pays ${cents(v.dnWin)})` };
    ok.sort((x, y) => y[1] - x[1]); // the side most likely to win
    const [side, price, w] = ok[0];
    return { act: true, side, price, why: `BET ${side} @ ${cents(price)} — win pays ${cents(w)} (goal ${S.goal}¢)` };
  }

  async function maybeTrade(v, d) {
    if (!S.auto || !d.act || live.busy) return;
    if (pageSlug() !== v.m.slug) { location.href = "/event/" + v.m.slug; return; }
    live.busy = true;
    D.lastSlug = v.m.slug; save(); // never twice in one 5 min, even after a reload
    const amt = +S.amount;
    log(`➡ ${d.why} — $${amt}`);
    const r = await placeOrder(d.side, amt).catch((e) => ({ ok: false, why: String(e) }));
    if (r.ok) {
      D.trades++;
      D.ledger = r.cash1;
      D.pending.push({ slug: v.m.slug, side: d.side, amt, cost: r.cost, price: d.price, end: v.m.end });
      log(`✔ bought ${d.side} — balance $${r.cash0} → $${r.cash1} (cost $${r.cost.toFixed(2)})`);
    } else {
      if (r.clicked && r.cash0 != null) D.unconf = { slug: v.m.slug, side: d.side, amt, price: d.price, end: v.m.end, cash0: r.cash0, at: Date.now() };
      log(`✖ not placed: ${r.why}`);
      if (!r.clicked && /disabled|amount box/.test(r.why)) D.lastSlug = ""; // Buy wasn't pressed → can try again
    }
    save(); live.busy = false;
  }

  async function settle() {
    for (const p of D.pending.filter((p) => Date.now() > p.end + 15000)) {
      try {
        const m = await getEvent(p.slug);
        if (!m.resolved || m.op.length < 2) continue;
        const upWon = m.op[0] >= 0.99 ? true : m.op[1] >= 0.99 ? false : null;
        if (upWon == null) continue;
        const win = (p.side === "Up") === upWon;
        const cost = p.cost ?? p.amt;
        if (!win) {
          D.pnl = r2(D.pnl - cost); D.l++;
          D.pending = D.pending.filter((x) => x !== p);
          log(`L ${p.side} −$${cost.toFixed(2)} (already left your balance) — today ${money(D.pnl)}`);
        } else if (!p.paying) {
          p.paying = true; p.expect = r2(cost / p.price); p.wonAt = Date.now();
          log(`market says ${p.side} WON — waiting to see $${p.expect.toFixed(2)} arrive in your balance`);
        }
        continue;
      } catch (_) {}
      if (!p.paying && Date.now() > p.end + 30 * 60000) { D.pending = D.pending.filter((x) => x !== p); log(`? ${p.side} — no result after 30 min, not counted`); }
    }
    save();
  }

  // Match every change in your Cash balance to PolyRider's bets; only real money moves are counted.
  function watchBalance() {
    const c = cashNow();
    if (c == null) return;
    if (D.dayCash == null) { D.dayCash = c; save(); }
    if (D.ledger == null) { D.ledger = c; save(); return; }
    let delta = r2(c - D.ledger);
    if (Math.abs(delta) < 0.01) return;
    // 1) a bet that looked unconfirmed but the money did leave (slow update)
    if (D.unconf && delta <= -D.unconf.amt * 0.5) {
      const u = D.unconf; D.unconf = null;
      const cost = r2(-delta);
      D.trades++; D.pending.push({ slug: u.slug, side: u.side, amt: u.amt, cost, price: u.price, end: u.end });
      D.ledger = c; save(); log(`✔ late confirm: ${u.side} bought, cost $${cost.toFixed(2)} left your balance`); return;
    }
    // 2) a winning bet being paid out
    const pay = D.pending.filter((p) => p.paying).sort((a, b) => Math.abs(delta - a.expect) - Math.abs(delta - b.expect))[0];
    if (pay && delta >= pay.expect * 0.8) {
      const g = r2(delta - (pay.cost ?? pay.amt));
      D.pnl = r2(D.pnl + g); D.w++;
      D.pending = D.pending.filter((x) => x !== pay);
      D.ledger = c; save();
      log(`W ${pay.side} paid ✓ +$${delta.toFixed(2)} came into your balance → profit ${money(g)} — today ${money(D.pnl)}`);
      return;
    }
    // 3) anything else (deposit, withdrawal, your own manual bets) is not counted
    if (!pay || delta < 0) { log(`balance changed by ${money(delta)} outside PolyRider — not counted`); D.ledger = c; save(); }
  }

  // ---------- loop ----------
  let lastMkt = 0, lastSettle = 0, ticking = false, tickStart = 0;
  async function tick() {
    if (ticking && Date.now() - tickStart < 15000) return; // a stuck step can't freeze it
    ticking = true; tickStart = Date.now();
    try {
      if (D.day !== today()) { D = { ...D, day: today(), pnl: 0, w: 0, l: 0, trades: 0, dayCash: cashNow() }; save(); }
      const now = Date.now(), slug = slugFor(now);
      const intoWin = (now - winStart(now)) / 1000, lft = 300 - intoWin;
      if (S.auto && !live.busy) {
        // go to the live 5 min market
        if (pageSlug() !== slug && intoWin > 1.5) { live.status = "moving to the live 5 min market…"; draw(); location.href = "/event/" + slug; return; }
        // fresh page a few seconds into every new 5 min (like pressing refresh)
        if (intoWin >= 3 && intoWin < 240 && sessionStorage.getItem("pr_loaded") !== slug) {
          sessionStorage.setItem("pr_loaded", slug); live.status = "refreshing page for fresh prices…"; draw(); location.reload(); return;
        }
        // page price doesn't match the real price for 4s → refresh (max once / 45s, never in the last 10s)
        if (live.staleSince && now - live.staleSince > 4000 && lft > 10 && now - (+sessionStorage.getItem("pr_reload_ts") || 0) > 45000) {
          sessionStorage.setItem("pr_reload_ts", String(now)); log("page price stuck — refreshing"); location.reload(); return;
        }
      }
      if (!live.mkt || live.mkt.slug !== slug || now - lastMkt > 1000) {
        lastMkt = now;
        getEvent(slug).then((m) => { live.mkt = m; live.mktTs = Date.now(); }).catch((e) => { live.status = "Polymarket: " + e.message; });
      }
      const v = view(), d = decide(v);
      live.status = S.auto ? d.why : "Auto is OFF — " + d.why;
      if (v && v.m.slug === slug) await maybeTrade(v, d);
      if (D.unconf && now - D.unconf.at > 60000) { log(`✖ ${D.unconf.side} never left your balance — not a trade`); D.unconf = null; save(); }
      if (now - lastSettle > 10000 && D.pending.length) { lastSettle = now; settle(); }
      watchBalance();
      draw(v);
    } catch (e) { live.status = "error: " + e.message; draw(); }
    finally { ticking = false; }
  }

  // ---------- panel ----------
  const host = document.createElement("div");
  host.id = "polyrider-panel";
  host.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `<style>
    *{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
    .p{width:300px;background:#11151c;color:#e6e9ef;border:1px solid #2a3240;border-radius:10px;font-size:12px;box-shadow:0 6px 24px #0008}
    .h{display:flex;align-items:center;gap:6px;padding:7px 9px;background:#1a202b;border-radius:10px 10px 0 0;cursor:move;user-select:none}
    .h b{flex:1;font-size:13px}.v{color:#7d8696;font-size:10px}
    button{background:#2a3240;color:#e6e9ef;border:0;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer}
    .on{background:#1f9d55!important;color:#fff}.off{background:#c0392b!important;color:#fff}
    .b{padding:8px 9px}.row{display:flex;justify-content:space-between;align-items:center;margin:3px 0}.k{color:#8a93a3}
    .big{font-size:15px;font-weight:600}.g{color:#3ddc84}.r{color:#ff6b6b}
    .in{display:flex;gap:4px;align-items:center;margin-top:5px}
    .in input{width:62px;background:#0b0e13;color:#fff;border:1px solid #3a4456;border-radius:5px;padding:4px 6px;font-size:14px;font-weight:600}
    .in .lbl{width:44px;color:#8a93a3}.in button{padding:4px 5px}
    .sec{margin-top:6px;padding:5px 7px;background:#161b24;border-radius:6px}
    .st{margin:6px 0;padding:6px 7px;background:#1a202b;border-radius:6px;min-height:18px;font-weight:600}
    .log{max-height:110px;overflow:auto;font-size:10.5px;color:#b9c0cc;margin-top:6px;border-top:1px solid #2a3240;padding-top:4px;white-space:pre-wrap}
  </style>
  <div class="p">
    <div class="h" id="drag"><b>PolyRider BTC 5m</b><span class="v">v${VER}</span><button id="auto">Auto</button><button id="min">–</button></div>
    <div class="b" id="body">
      <div class="in"><span class="lbl">Bet $</span><input id="amt"><button data-a="1">$1</button><button data-a="2">$2</button><button data-a="5">$5</button><button data-a="10">$10</button><button data-a="100">$100</button></div>
      <div class="in"><span class="lbl">Goal ¢</span><input id="goal"><span class="k" id="goalTip"></span></div>
      <div class="in"><span class="lbl">Bet at</span><input id="when"><button data-w="60">1:00</button><button data-w="90">1:30</button><button data-w="120">2:00</button><button data-w="180">3:00</button><span class="k">left</span></div>
      <div class="row" style="margin-top:7px"><span class="k">Time left</span><span class="big" id="left">–</span></div>
      <div class="sec">
        <div class="row"><span>Up <b id="pu">–</b></span><span class="k" id="wu">–</span></div>
        <div class="row"><span>Down <b id="pd">–</b></span><span class="k" id="wd">–</span></div>
      </div>
      <div class="st" id="st">starting…</div>
      <div class="row"><span class="k">Cash (from your balance)</span><span id="cash">–</span></div>
      <div class="row"><span class="k">Today (checked vs balance)</span><span class="big" id="pnl">$0.00</span></div>
      <div class="row"><span class="k">W / L / bets</span><span id="wl">0 / 0 / 0</span></div>
      <div class="row" style="margin-top:6px;justify-content:flex-start"><button id="reset">Reset today</button></div>
      <div class="log" id="log"></div>
    </div>
  </div>`;
  const $ = (id) => sh.getElementById(id);
  function goalTip() {
    const a = +S.amount, g = S.goal / 100;
    $("goalTip").textContent = `bets at ${Math.ceil((a / (a + g)) * 100)}¢ or more`;
  }
  function setAmt(a) {
    a = Math.round(+a * 100) / 100;
    if (!(a >= 1)) { $("amt").value = S.amount; return; }
    S.amount = a; $("amt").value = a; save(); goalTip();
  }
  function setGoal(g) {
    g = Math.round(+g * 10) / 10;
    if (!(g > 0)) { $("goal").value = S.goal; return; }
    S.goal = g; $("goal").value = g; save(); goalTip();
  }
  const mmss = (sec) => `${Math.floor(sec / 60)}:${p2(Math.round(sec % 60))}`;
  function setWhen(x) { // accepts 2 (minutes), 1:30, or 90s
    x = String(x).trim(); let sec;
    if (/^\d+:\d{1,2}$/.test(x)) { const [m, ss] = x.split(":").map(Number); sec = m * 60 + ss; }
    else if (/s$/i.test(x)) sec = parseFloat(x);
    else sec = parseFloat(x) * 60;
    if (!(sec >= 5 && sec <= 295)) { $("when").value = mmss(S.lastSec); return; }
    S.lastSec = Math.round(sec); $("when").value = mmss(S.lastSec); save();
  }
  $("when").addEventListener("change", () => setWhen($("when").value));
  sh.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => setWhen(b.dataset.w + "s")));
  $("amt").addEventListener("change", () => setAmt($("amt").value));
  $("goal").addEventListener("change", () => setGoal($("goal").value));
  sh.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => setAmt(b.dataset.a)));

  function drawLog() { $("log").textContent = D.log.join("\n"); }
  const money = (n) => (n >= 0 ? "+$" : "–$") + Math.abs(n).toFixed(2);
  function draw(v) {
    $("auto").textContent = S.auto ? "Auto ON" : "Auto OFF";
    $("auto").className = S.auto ? "on" : "off";
    $("st").textContent = live.status;
    $("pnl").textContent = money(D.pnl); $("pnl").className = "big " + (D.pnl >= 0 ? "g" : "r");
    $("wl").textContent = `${D.w} / ${D.l} / ${D.trades}` + (D.pending.length ? ` (${D.pending.length} waiting)` : "");
    { const c = cashNow(); $("cash").textContent = c == null ? "can't read" : `$${c.toFixed(2)}` + (D.dayCash != null ? ` (today ${money(r2(c - D.dayCash))})` : ""); }
    if (!v) return;
    const s = Math.max(0, Math.floor(v.left));
    $("left").textContent = `${Math.floor(s / 60)}:${p2(s % 60)}`;
    const g = S.goal / 100;
    $("pu").textContent = cents(v.upP); $("pd").textContent = cents(v.dnP);
    $("wu").textContent = v.upWin != null ? `win pays ${cents(v.upWin)}` : "–";
    $("wd").textContent = v.dnWin != null ? `win pays ${cents(v.dnWin)}` : "–";
    $("wu").className = v.upWin != null && v.upWin <= g ? "g" : "k";
    $("wd").className = v.dnWin != null && v.dnWin <= g ? "g" : "k";
  }
  $("auto").onclick = () => { S.auto = !S.auto; save(); log(S.auto ? "Auto ON" : "Auto OFF"); draw(view()); };
  $("min").onclick = () => { const b = $("body"); b.style.display = b.style.display === "none" ? "" : "none"; };
  $("reset").onclick = () => { D.pnl = 0; D.w = 0; D.l = 0; D.trades = 0; D.dayCash = cashNow(); D.ledger = cashNow(); save(); log("today reset"); draw(view()); };
  (() => { // drag
    let sx, sy, ox, oy, on = false;
    $("drag").addEventListener("mousedown", (e) => { if (e.target.tagName === "BUTTON") return; on = true; sx = e.clientX; sy = e.clientY; const r = host.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if (!on) return; host.style.left = ox + e.clientX - sx + "px"; host.style.top = oy + e.clientY - sy + "px"; host.style.bottom = "auto"; });
    window.addEventListener("mouseup", () => { on = false; });
  })();

  chrome.storage.local.get(["pr_set", "pr_day"], (r) => {
    const old = r.pr_set || {};
    S = old.v === 5 ? { ...DEF, ...old } : { ...DEF, amount: old.amount || DEF.amount };
    D = { ...D, ...(r.pr_day || {}) };
    document.documentElement.appendChild(host);
    $("amt").value = S.amount; $("goal").value = S.goal; goalTip(); $("when").value = mmss(S.lastSec);
    drawLog(); draw(); save();
    if (pageSlug() === slugFor(Date.now()) && (Date.now() - winStart()) / 1000 >= 2.5) sessionStorage.setItem("pr_loaded", pageSlug());
    setInterval(tick, 500);
  });
})();
