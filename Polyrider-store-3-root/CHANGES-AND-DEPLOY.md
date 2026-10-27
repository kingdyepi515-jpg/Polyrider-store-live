# PolyRider checkout fix — changes, cause, deployment

Repo layout: this ZIP mirrors your GitHub repo (`polyrider-store 2/` is the Render `rootDir`). Copy the changed files over the same paths.

## Exact cause of "Checkout opens soon — the seller is finishing setup."
`public/js/index.js` shows it (and disables the button) when `/api/store` returns `ready: false` (or salesOpen false).
In `server.js`, `ready` was `btc.validAddress(await orders.receivingAddress())`, i.e. "is a legacy bc1… Bitcoin address saved?".
But the store now takes Cash App payments: `createOrder()` in `src/orders.js` requires `CASH_APP_TAG`, and never uses that address.
So with `CASH_APP_TAG` set but no bc1 address, the site said "opens soon" although orders could be created.
**Fix:** `ready` is now `!!config.cashAppTag`. The message can now only appear when `CASH_APP_TAG` is really empty (or sales are paused in /admin).
Reproduced in a browser: old index.js + ready=false => that exact message and a disabled button.

## Second cause of the refresh / dead button: the repo's index.html had been replaced
The repo's `public/index.html` and `public/order.html` were pasted-in static pages:
- they began/ended with a literal markdown fence (```html), shown as text on the page;
- `index.html` had its checkout logic in an inline `<script>`. `server.js` sends a CSP with `script-src 'self'`, so browsers BLOCK inline scripts: clicking the button did nothing, and pressing Enter submitted the form natively = page refresh to `/?email=…`;
- neither page loaded `common.js`/`index.js` (no price, no support email, no real order creation);
- `order.html` did not match `order.js` (missing elements), so real order links were broken; `order.js` also hard-coded $29.99.
Reproduced under the real CSP: click = nothing, Enter = reload, QR never shown.

## Files changed
| File | Change |
|---|---|
| `server.js` | `/api/store` `ready` now = Cash App tag configured |
| `public/index.html` | fences removed; inline script removed; loads common.js + index.js; button is a real submit; your design/markup kept; price via `data-price`; order number + "Open my order page" link |
| `public/js/index.js` | submit handler (click AND Enter): validates email, creates a real order via `/api/orders`, reveals the QR (`/IMG_8282.jpg`) in place with no navigation, guards duplicate orders, shows server errors |
| `public/order.html` | rebuilt to match `order.js` and `style.css` (status, QR, amount, copy buttons) |
| `public/js/order.js` | no hard-coded 29.99 (uses the order's amount); shows `/IMG_8282.jpg`; "Open Cash App link" uses the order's link |
| `tests/browser/*` | new Playwright test + mock server (not part of `npm test`) |

## Deploy
1. Copy the changed files into your repo (same paths), commit, push. Render redeploys.
2. In Render -> Environment confirm: `CASH_APP_TAG` (your $cashtag; the QR says `$trading123`, enter it without `$` if that is right), `PRICE_USD=10.99`, `SUPPORT_EMAIL` (or ADMIN_EMAIL), `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. (If `PRICE_USD` is missing the code default is 29.99.)
3. /admin -> make sure sales are not paused.
4. Hard-refresh the live site. Test click and Enter with a real email. This creates one real order in your admin list; reject/delete it afterward.
5. Optional: `npm i -D playwright && npx playwright install chromium && node tests/browser/checkout.js https://polyrider-store.onrender.com`

## Not verified / needs your attention
- I could NOT run your real server (npm registry blocked in my environment), so server.js + database + email were not executed. The server change is one line, syntax-checked. Frontend was tested in Chromium against a mock of the same API with the same CSP.
- I could not access your live site's JS/env, so I can't tell which of CASH_APP_TAG missing / old ready-check caused your live message; the fix covers the second, and the message still (correctly) shows if CASH_APP_TAG is empty.
- `tests/pages.js` and `tests/run.js` (npm test) still assume the old bc1-address flow ($29.99, address, timer); they were already out of date with the Cash App code and I did not change or run them.
- The QR image is a Cash App Bitcoin QR with no amount; customers must type the amount. Payment is verified by you manually in /admin; the pages say so and never claim payment is received.
