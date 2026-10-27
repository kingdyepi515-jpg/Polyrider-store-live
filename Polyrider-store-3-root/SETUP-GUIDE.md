# PolyRider BTC 5m Store — Setup & Owner Guide

This folder is your complete store: the sales website, Cash App orders, license keys, protected downloads, the private admin panel, and the licensed copy of your PolyRider extension.

Everything below uses **free** services. You only need to create the accounts yourself (Claude can't create accounts or enter passwords for you).

---

## 1. What's in this folder

| Folder / file | What it is |
|---|---|
| `server.js`, `src/` | The backend: orders, Cash App checking, licenses, downloads, admin API, emails |
| `public/` | The customer website: home/sales page, order page, download page, install guide |
| `admin/` | Your private admin panel (at `/admin`, needs your login) |
| `extension-original/` | An exact copy of your PolyRider files, untouched |
| `extension/` | The licensed PolyRider (same bot + license check) |
| `release-seed/` | The first release ZIP (v4.3.0). The store publishes it on first start |
| `scripts/build-release.js` | Rebuilds the licensed extension + ZIP from `extension-original/` |
| `tests/` | Automated tests (`npm test`) |
| `render.yaml` | One-click hosting setup for Render |
| `.env.example` | List of all settings |

Your original folder `Downloads/polyrider` was **not changed**. A backup was also made at `Downloads/polyrider-ORIGINAL-BACKUP`.

### Exactly what changed in the extension

The trading logic, strategy, design, and settings are the same. Only these changes were made:

1. **`manifest.json`**
   - version is now 4.3.0
   - it may contact your store's address (`host_permissions`)
   - it runs `license.js` in the background
   - it loads `gate.js` before `content.js`
2. **`content.js`** — only 3 lines changed, all other 425 are identical:
   - line 8: the version label now reads the version from the manifest instead of hard-coded "4.2.0"
   - line 418: start-up now waits for the license check, `window.__prGate(() => …`
   - line 427: the closing bracket for that
3. **New `gate.js`**
   - shows a small "Enter your license key" box until the license is active
   - re-checks every hour
   - shows a green "update available" note when you publish a new version
4. **New `license.js`** — talks only to your store server, never to Polymarket.
5. **Not included in the paid ZIP:** `sw.js`. It was old leftover code that your manifest never loaded, so the bot never used it. It is still in your original folder and in the backup.

---

## 2. Accounts you need (all free)

1. **GitHub** (github.com): holds the code so the host can run it.
2. **Render** (render.com): runs the website.
   - Free plan: it sleeps after 15 minutes without visitors and takes about a minute to wake up.
   - It doesn't keep files, which is why you need Turso.
3. **Turso** (turso.tech): the database that keeps your orders and licenses.
   - Free plan: 5 GB storage, 100 databases.
4. **Brevo** (brevo.com), *optional but recommended*: sends the license emails.
   - Free plan: 300 emails per day.

---

## 3. Put the store on GitHub

1. Sign in to github.com and click **+** (top-right) → **New repository**.
2. Name it `polyrider-store`, choose **Private**, and click **Create repository**.
3. On the next page, click **uploading an existing file**.
4. Open the `polyrider-store` folder on your Mac.
5. Select **everything inside it except `node_modules`** and drag it into the GitHub page. Include the hidden files `.gitignore` and `.env.example`: press Cmd+Shift+. in Finder to show hidden files.
6. Click **Commit changes**.

## 4. Create the database (Turso)

1. Sign in to turso.tech → **Create Database** → name it `polyrider` → pick the location closest to you → **Create**.
2. On the database page, copy the **URL**. It looks like `libsql://polyrider-yourname.turso.io`.
3. Click **Create Token**, choose no expiration, and copy the token. Keep it secret.

## 5. Put the website online (Render)

1. Sign in to render.com with your GitHub account.
2. Click **New +** → **Blueprint** → choose your `polyrider-store` repository → **Connect**.
3. Render reads `render.yaml` and asks for these values:
   - `DATABASE_URL` → the Turso URL
   - `DATABASE_AUTH_TOKEN` → the Turso token
   - `ADMIN_EMAIL` → your email (used to log in to the admin panel)
   - `ADMIN_PASSWORD` → a strong password of at least 12 characters
   - `CASH_APP_TAG` → your Cash App bitcoin address. In Cash App: Money tab → Cash App → Deposit/Receive → copy. It usually starts with `bc1`.
   - `SUPPORT_EMAIL` → the email customers should write to
   - `BREVO_API_KEY` and `EMAIL_FROM` → leave empty for now (see section 7)
4. Click **Apply**. Render builds the store in a few minutes. `SERVER_SECRET` is created for you automatically.
   - **Never change `SERVER_SECRET` after you start selling.** Existing license keys depend on it.
5. Your store address is shown at the top, like `https://polyrider-store.onrender.com`. That's the link you share with customers.

## 6. First login and checks

1. Open `https://YOUR-STORE.onrender.com/admin` and log in with ADMIN_EMAIL and ADMIN_PASSWORD.
2. Go to **Settings** and check the Cash App address letter by letter against Cash App.
3. Check that **Sales open** is on and **Auto-approve** is off. With auto-approve off, nobody gets a license until you press Approve.
4. Go to **Versions** and confirm v4.3.0 is marked **current**.
5. In Settings, change your password once if you like. After that, the password in Render is no longer used.

## 7. Turn on emails (Brevo)

1. Sign up at brevo.com.
2. Go to **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**. Use the email you want to send from, then click the confirmation link Brevo emails you.
3. Go to **SMTP & API** → **API Keys** → **Generate a new API key** and copy it.
4. In Render, open your service → **Environment** and set:
   - `BREVO_API_KEY` = the key
   - `EMAIL_FROM` = the sender email you verified
5. Click **Save changes**. Render restarts the store.

After this:
- customers get their order link and license key by email automatically
- your admin login also asks for a 6-digit code sent to ADMIN_EMAIL

**Good to know:** sending "from" a free @gmail.com address through Brevo works, but some messages may land in spam. A cheap domain of your own (about $10/year), verified in Brevo, fixes that.

**Without email**, everything still works. When you approve an order, the admin panel shows the license key. Send it to the customer yourself, together with the link `https://YOUR-STORE.onrender.com/download.html`.

## 8. Do one real test purchase before you advertise

Real money is the only true test of the Cash App part. These tests used a simulated blockchain.

1. In Render → Environment, set `PRICE_USD` to `2` (two dollars) and save.
2. Open your store on your phone and buy with your email.
3. Pay from a **different** Cash App wallet, or from a friend's Cash App, to your own address. Use the exact amount shown.
4. Watch the order page go from "Payment detected" to "Payment confirmed".
5. Approve the order in the admin panel. Check the email, download the ZIP, and install it in Chrome (section 11).
6. Open polymarket.us. PolyRider should start with your key.
7. Set `PRICE_USD` back to `29.99`.

---

## 9. Everyday use (admin panel)

**Orders tab.** Click the orange **Needs my attention** box to see orders that need you. Click any row to open the order.

- **Payment confirmed — waiting for seller approval**
  - Check the amount, and open the order on mempool.space if you want.
  - Press **Approve payment & issue license**. A unique key is created and emailed.
- **Payment requires review** — the reason is shown, for example underpaid or paid more than 24h late.
  - Approve if you're happy, or press **Reject**.
- **Approve anyway (checked myself)**
  - Only for when you saw the money in Cash App but the blockchain check hasn't caught up.
  - You must type a note, and it's recorded in the audit log.
- **Show key / Resend email** — for customers who lost their email.
- **Suspend / Reactivate** — temporarily stop or restore a customer.
- **Revoke forever** — permanent. You must type REVOKE to confirm.
- **Move to new computer** — frees the license so the customer can activate it on another computer.

**Searching and sorting.** Search by email, order number, transaction ID, or the last 4 characters of a key. Click any column title to sort.

**Audit log.** Every approval, suspension, revocation, release, login, and key view is recorded with the time.

**Backups.** Settings → **Download backup** (do it weekly). Turso also keeps 1 day of point-in-time restore on the free plan.
- To restore after a disaster: create a new Turso database and point `DATABASE_URL` at it. Then send the backup file to Claude and ask it to re-import it.
- Keep `SERVER_SECRET` safe (Render → Environment). Without it, the encrypted keys in a backup can't be read.

## 10. Releasing an update

1. Make your changes in `extension-original/` (or ask Claude to). Then run `node scripts/build-release.js 4.3.1` with a higher version number. This creates `release-seed/polyrider-btc-5m-4.3.1.zip`.
2. Admin → **Versions** → choose the ZIP and write short release notes → **Upload**. Leave "make current" unticked.
   - The store refuses bad packages: a lower version, a missing license file, program files, or anything that looks like a secret.
3. Click **Test download**, install that copy on your own Chrome, and check it works.
4. Click **Make current**. From now on:
   - new downloads get the new version
   - every installed copy shows a green "update available" note within about an hour
5. If something is wrong, click **Withdraw**. The previous version becomes current again.
6. The **Customers on it** column shows how many active installs report each version.

**Important — updates are not automatic on customers' computers.** PolyRider is installed by hand ("Load unpacked"). Chrome only auto-updates extensions from the Chrome Web Store, or on company-managed computers. So customers update by downloading the new ZIP and replacing the files (instructions are on `/install.html`).

If you later want true automatic updates, the only supported way is publishing PolyRider as an **unlisted** item on the Chrome Web Store:
- $5 one-time developer fee
- Google reviews it and may reject a betting bot
- the license check stays the same

## 11. Customer install instructions

They are on your site at `/install.html`, with Windows and Mac tabs. The site picks the right tab automatically. In short:

**Windows**
1. Download the ZIP.
2. Right-click it → **Extract All** → **Extract**.
3. Move the folder to Documents.
4. In Chrome, go to `chrome://extensions` and turn on **Developer mode**.
5. Click **Load unpacked** and choose the folder that contains `manifest.json`.
6. Open polymarket.us and press F5.
7. Enter the key if it asks.

**Mac**
1. Download the ZIP.
2. Double-click it in Finder.
3. Move the folder to Documents.
4. In Chrome, go to `chrome://extensions` and turn on **Developer mode**.
5. Click **Load unpacked** and choose the folder that contains `manifest.json`.
6. Open polymarket.us and press ⌘R.
7. Enter the key if it asks.

The download already has the customer's key filled in, so most people never type it. Customers are never told to turn off antivirus or Chrome security.

---

## 12. How the protections work, and their honest limits

**Payment**
- **Cash App** has no API that tells a website "this bitcoin payment arrived." So the store reads the public Cash App blockchain (mempool.space) itself.
- Each order gets a unique amount. A tiny extra of under $1 makes every open order different, so payments can't be mixed up.
- The store checks:
  - the right address
  - the full amount
  - confirmations (`CONFIRMATIONS_REQUIRED`, default 1)
  - that the transaction isn't already used by another order
- A customer's transaction ID or screenshot alone never counts.
- **Lightning and other coins can't be detected.** The order page warns customers to send on the Cash App network.

**License keys**
- Keys are random (about 79 bits) and different for every order.
- The database stores keys only as a fingerprint plus an encrypted copy, so you can resend them.
- Keys are checked on the server.
- Wrong guesses are blocked after 10 per hour per connection.

**One computer per license**
- If the customer installs on a new computer, the license moves automatically once the old one has been quiet for 24 hours. This can happen at most 3 times per 30 days.
- You can also move it right away (**Move to new computer**).

**Suspend and revoke**
- These take effect at the extension's next check, which happens at least hourly and on every page load.
- If the license server can't be reached, PolyRider keeps working for up to **72 hours** after its last good check. After that it stops until it can check again. This is so that a sleeping or down server doesn't stop paying customers.

**What no license system can stop**
- Someone who has the files can copy them, or edit out the check.
- What the license system *does* stop: keys can't be shared freely, suspended people lose access at the next check, and every download is tied to a key.

**Downloads**
- Links work for 10 minutes and are signed, so guessing order numbers or links gets nowhere.
- A suspended or revoked customer can't download.
- The order page link is a long private code, not the order number.

**Admin**
- Login needs a password plus an emailed code (once email is set up).
- Wrong logins are slowed down.
- Sessions expire after 12 hours.
- Every change needs a secure cookie and a special header, so other websites can't trigger actions.

**Free hosting sleep**
- While the free Render server is asleep, nothing is checked.
- It wakes up when a customer opens the site, or when an installed PolyRider checks its license, and then checks all open orders.
- If you want it awake all the time, a free service like cron-job.org can open `https://YOUR-STORE.onrender.com/healthz` every 10 minutes. The free 750 hours per month cover one always-on service.

**Rules to check yourself**
- Polymarket's terms may not allow automated trading tools, and customers could lose their accounts.
- The name "PolyRider" could draw a trademark complaint from Polymarket.
- Selling software for prediction-market betting may have legal and tax rules where you live.

---

## 13. Testing checklist

Automated (run `npm test` in this folder). All of these pass:

| # | Check | Result |
|---|---|---|
| 1 | Valid email accepted, invalid refused | ✅ automated |
| 2 | Order created correctly (number, amount, status) | ✅ automated |
| 3 | QR code contains the right address and amount | ✅ automated |
| 4 | Unpaid order gets no license | ✅ automated |
| 5 | Unconfirmed transaction gets no license | ✅ automated |
| 6 | Confirmed payment can be approved | ✅ automated |
| 7 | Unique license generated | ✅ automated |
| 8 | Customer gets the right email (key, download, install links) | ✅ automated (simulated sending) |
| 9 | Right customer can download; the ZIP has their key | ✅ automated |
| 10 | Wrong email, wrong key, or guessed/edited links can't download | ✅ automated |
| 11 | Key works on one computer only; brute force blocked | ✅ automated |
| 12 | Suspended license rejected (extension stops, downloads blocked) | ✅ automated |
| 13 | Reactivated license works again | ✅ automated |
| 14 | Duplicate checks/approvals never make a second license; a transaction can't be reused | ✅ automated |
| 15 | Failed emails retry and send exactly once | ✅ automated |
| 16 | Original PolyRider code unchanged except the 3 lines; the panel still starts | ✅ automated |
| 17 | Upload, publish, update notice, withdraw/roll back | ✅ automated |
| 18 | Admin locked to everyone not logged in (incl. code step) | ✅ automated |
| 19 | Website on phone, Windows, Mac | ⚠️ layout is responsive and tested in a simulated browser — **check on your phone and computer after going live** |
| 20 | No secrets in the website or extension | ✅ automated |
| — | Underpayment, overpayment, late payment, wrong address, fake transaction ID | ✅ automated |
| — | Real Cash App payment through Cash App | ⚠️ **do the $2 test in section 8** |
| — | Real Chrome install on Windows and Mac + real trading on polymarket.us | ⚠️ **check yourself with the test purchase** (the license gate was tested in a simulated Chrome page) |

## 14. Costs

| Item | Cost |
|---|---|
| Render (website, free plan) | $0 |
| Turso (database, free plan) | $0 |
| Brevo (emails, free plan, 300/day) | $0 |
| mempool.space blockchain checks | $0 |
| GitHub (private repository) | $0 |
| Cash App network fees | paid by the customer when sending |
| Optional: own domain name | about $10–15 per year |
| Optional: Render paid plan (never sleeps) | about $7 per month |
| Optional: Chrome Web Store developer account | $5 one time |

Cash App's own fees apply when you sell or withdraw the bitcoin you receive.


## Cash App manual payments and monthly licenses
Set `CASH_APP_TAG` to your Cash App cashtag without the `$` (example: `YourCashtag`). The customer QR code opens a Cash App payment URL for $29.99; verify the exact link format and complete a small test before selling. Orders show a QR code for a Cash App payment link and are not auto-confirmed. In the admin order details, use **Approve anyway (checked myself)** only after you personally verify the $29.99 payment in Cash App. Approval issues a unique license and emails the customer when Brevo is configured. Licenses expire after 30 days; renewals are handled from the license/admin controls.
