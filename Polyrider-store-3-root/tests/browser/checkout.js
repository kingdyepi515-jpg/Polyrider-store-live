// Real-browser test of the checkout flow (Playwright + Chromium).
//   node tests/browser/checkout.js                 -> starts mock-server.js (same /api contract + same CSP as server.js)
//   node tests/browser/checkout.js https://polyrider-store.onrender.com   -> runs against a live site
//     (live mode creates ONE real order for checkout-test@example.com; delete it in /admin afterwards)
// Setup once:  npm i -D playwright && npx playwright install chromium
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const PUB = path.join(__dirname, "..", "..", "public");
async function mock(port, ready = "1", open = "1") { const s = spawn("node", [path.join(__dirname, "mock-server.js"), PUB, port, ready, open]); await sleep(700); return s; }

(async () => {
  const live = process.argv[2];
  const browser = await chromium.launch();
  const shots = process.env.SHOT_DIR || ".";
  let srv, base = live;
  if (!live) { srv = await mock(4201); base = "http://127.0.0.1:4201"; }

  for (const [name, vp] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 667 }]]) {
    for (const mode of ["click", "enter"]) {
      const tag = `[${name}/${mode}] `;
      const page = await browser.newPage({ viewport: vp });
      const problems = []; let navs = 0;
      page.on("framenavigated", () => navs++);
      page.on("pageerror", (e) => problems.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy/.test(m.text())) problems.push(m.text()); });
      await page.goto(base + "/"); const n0 = navs;
      ok(!(await page.innerText("body")).includes("```"), tag + "no stray markdown fences on the page");
      if (!live) await page.waitForFunction(() => document.querySelector("[data-price]").textContent === "$10.99");
      ok(await page.isHidden("#bitcoin-payment"), tag + "QR hidden before checkout");
      const go = () => (mode === "click" ? page.click("#buyBtn") : page.press("#email", "Enter"));
      for (const bad of ["", "abc", "a@b"]) {
        await page.fill("#email", bad); await go();
        ok((await page.textContent("#err")).includes("valid email") && await page.isHidden("#bitcoin-payment"), tag + `rejects "${bad}"`);
      }
      await page.fill("#email", live ? "checkout-test@example.com" : "buyer@example.com"); await go();
      await page.waitForSelector("#bitcoin-payment", { state: "visible", timeout: 8000 });
      await page.waitForFunction(() => document.getElementById("payment-status").textContent.length > 0);
      ok(await page.evaluate(() => { const i = document.getElementById("bitcoin-qr"); return i.complete && i.naturalWidth > 0; }), tag + "actual QR image (/IMG_8282.jpg) loaded");
      ok(/Order PR-/.test(await page.textContent("#order-created")), tag + "real order created: " + (await page.textContent("#order-created")));
      ok(/^\/order\.html#t=.{20,}/.test(await page.getAttribute("#order-link", "href")), tag + "order link has private token");
      ok(navs === n0 && !page.url().includes("?"), tag + "page did not refresh/navigate (" + page.url() + ")");
      ok(!(await page.content()).includes("Checkout opens soon") || (await page.textContent("#err")) === "", tag + "no 'Checkout opens soon' error shown");
      ok(/^\$\d+\.\d\d$/.test(await page.textContent("[data-price]")), tag + "price filled by common.js");
      ok((await page.textContent("[data-support]")).trim().length > 0, tag + "support text present");
      ok((await page.textContent("#bitcoin-payment")).includes("checked manually"), tag + "manual verification stated");
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tag + "no horizontal overflow");
      ok(problems.length === 0, tag + "no console/CSP errors " + problems.join(" | "));
      await go(); await sleep(300);
      if (!live) ok((await (await fetch(base + "/__orders")).json()).n === (global.__expected = (global.__expected || 0) + 1), tag + "second submit did not create a duplicate order");
      await page.screenshot({ path: `${shots}/home-${name}-${mode}.png`, fullPage: false });
      // order page
      const href = await page.getAttribute("#order-link", "href");
      await page.goto(base + href); await page.waitForSelector("#app:not(.hide)", { timeout: 8000 });
      ok(await page.evaluate(() => { const i = document.querySelector("#qr img"); return i && i.complete && i.naturalWidth > 0; }), tag + "order page shows the QR image");
      ok((await page.textContent("#btc1")).includes("10.99") && !(await page.content()).includes("29.99"), tag + "order page shows $10.99 (no stale $29.99)");
      ok(/Awaiting payment/.test(await page.textContent("#statusText")), tag + "order page status shown");
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tag + "order page: no horizontal overflow");
      await page.screenshot({ path: `${shots}/order-${name}-${mode}.png`, fullPage: true });
      await page.close();
    }
  }
  if (srv) {
    srv.kill();
    // store not ready / paused states (the ONLY cases where the message may appear)
    for (const [ready, open, expect] of [["0", "1", /Checkout opens soon/], ["1", "0", /Sales are paused/]]) {
      const s = await mock(4202, ready, open); const p = await browser.newPage();
      await p.goto("http://127.0.0.1:4202/"); await sleep(700);
      ok(expect.test(await p.textContent("#err")) && await p.isDisabled("#buyBtn"), `store ready=${ready} open=${open}: shows ${expect}`);
      await p.close(); s.kill();
    }
  }
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})();
