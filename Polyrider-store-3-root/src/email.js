// Email: every message goes into an "outbox" table first, then is sent. Failed sends retry automatically.
const fs = require("fs");
const config = require("./config");
const { run, all } = require("./db");

const configured = () => !!(config.emailCaptureFile || (config.brevoKey && config.emailFrom));

async function deliver(m) {
  if (config.emailCaptureFile) { // test mode: write to a file instead of sending
    fs.appendFileSync(config.emailCaptureFile, JSON.stringify({ to: m.to_addr, subject: m.subject, text: m.text }) + "\n");
    return;
  }
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "api-key": config.brevoKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: config.emailFromName, email: config.emailFrom },
      to: [{ email: m.to_addr }],
      subject: m.subject, htmlContent: m.html, textContent: m.text,
    }),
  });
  if (!r.ok) throw new Error(`Email service said ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function attempt(m) {
  try {
    await deliver(m);
    await run("UPDATE outbox SET status='sent', sent_at=?, tries=tries+1, last_error=NULL WHERE id=?", [Date.now(), m.id]);
    return true;
  } catch (e) {
    const tries = (m.tries || 0) + 1;
    await run("UPDATE outbox SET status=?, tries=?, last_error=? WHERE id=?", [tries >= 6 ? "failed" : "retry", tries, String(e.message).slice(0, 300), m.id]);
    return false;
  }
}

// queue + try right away. Returns {queued, sent, configured}
async function send({ to, subject, html, text, kind = null, orderId = null }) {
  if (!configured()) return { queued: false, sent: false, configured: false };
  const r = await run("INSERT INTO outbox (to_addr, subject, html, text, kind, order_id, status, created_at) VALUES (?,?,?,?,?,?, 'queued', ?)",
    [to, subject, html, text, kind, orderId, Date.now()]);
  const id = Number(r.lastInsertRowid);
  const sent = await attempt({ id, to_addr: to, subject, html, text, tries: 0 });
  return { queued: true, sent, configured: true };
}

async function retryPending() {
  if (!configured()) return;
  for (const m of await all("SELECT * FROM outbox WHERE status IN ('queued','retry') ORDER BY id LIMIT 20")) await attempt(m);
}

// ---------- templates ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="font-weight:800;font-size:20px;margin-bottom:16px">${esc(config.productName)}</div>
<div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</div>
<p style="color:#6b7280;font-size:12px;margin-top:16px">${config.supportEmail ? `Need help? Reply to this email or write to ${esc(config.supportEmail)}.` : ""}</p>
</div></body></html>`;
}
const btn = (href, label) => `<p style="margin:20px 0"><a href="${esc(href)}" style="background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block">${esc(label)}</a></p>`;

function licenseEmail({ orderId, key, downloadUrl, installUrl }) {
  const subject = `Your ${config.productName} license key (order ${orderId})`;
  const html = layout("Payment approved — here is your license", `
<p>Thank you for your purchase. Your payment for order <b>${esc(orderId)}</b> was approved.</p>
<p style="margin:16px 0 6px;color:#6b7280">Your license key (keep it private):</p>
<div style="font-family:Menlo,Consolas,monospace;font-size:20px;font-weight:700;background:#f3f4f6;padding:12px;border-radius:8px;letter-spacing:1px">${esc(key)}</div>
${btn(downloadUrl, "Download " + config.productName)}
<p><b>How it works:</b></p>
<ol style="padding-left:20px;line-height:1.6">
<li>Open the download link above. Enter this email address and your license key.</li>
<li>Download the ZIP file and <b>extract (unzip) it</b> first — Chrome can't install the ZIP itself.</li>
<li>Follow the Windows or Mac steps here: <a href="${esc(installUrl)}">${esc(installUrl)}</a></li>
<li>Open polymarket.us — the ${esc(config.productName)} panel will activate with your key.</li>
</ol>
<p style="color:#6b7280;font-size:13px">One license works on one computer. If you change computers, contact us and we'll move it for you.</p>`);
  const text = `Your payment for order ${orderId} was approved.\n\nLicense key: ${key}\n\nDownload: ${downloadUrl}\nInstall steps (Windows & Mac): ${installUrl}\n\nUnzip the file first, then load the folder in Chrome. One license = one computer.`;
  return { subject, html, text };
}
function recoveryEmail({ links, downloadUrl }) {
  const subject = `Your ${config.productName} orders`;
  const html = layout("Here are your orders", `
<p>Someone (hopefully you) asked for the links to your ${esc(config.productName)} orders.</p>
<ul style="line-height:1.8;padding-left:20px">${links.map((l) => `<li><a href="${esc(l.url)}">Order ${esc(l.id)}</a> — ${esc(l.status)}${l.key ? ` — license key: <b style="font-family:monospace">${esc(l.key)}</b>` : ""}</li>`).join("")}</ul>
${links.some((l) => l.key) ? btn(downloadUrl, "Go to the download page") : ""}
<p style="color:#6b7280;font-size:13px">These links expire in 2 hours. If you didn't ask for this, you can ignore this email.</p>`);
  const text = "Your orders:\n" + links.map((l) => `- ${l.id} (${l.status}) ${l.url}${l.key ? " key: " + l.key : ""}`).join("\n") + `\n\nDownload page: ${downloadUrl}`;
  return { subject, html, text };
}
function orderCreatedEmail({ orderId, orderUrl, btc, address }) {
  const subject = `${config.productName} order ${orderId} — payment details`;
  const html = layout("Your PolyRider order is waiting for payment", `
<p>Order <b>${esc(orderId)}</b> was created for a monthly PolyRider license. Please send <b>${esc(btc)}</b> using Cash App:</p>
<div style="font-family:monospace;background:#f3f4f6;padding:10px;border-radius:8px;word-break:break-all">${esc(address)}</div>
${btn(orderUrl, "Open my order page")}
<p>The seller checks Cash App payments manually. Your license is emailed after payment is verified and approved. Keep this email for your order status.</p>`);
  const text = `Order ${orderId}. Send ${btc} using Cash App: ${address}.\nYour order page: ${orderUrl}\nPayment is checked manually.`;
  return { subject, html, text };
}
function adminCodeEmail(code) {
  return { subject: `${config.productName} admin login code: ${code}`,
    html: layout("Admin login code", `<p>Your code is</p><div style="font-size:28px;font-weight:800;letter-spacing:4px">${esc(code)}</div><p style="color:#6b7280">It expires in 10 minutes. If you didn't try to log in, change your admin password.</p>`),
    text: `Your admin login code: ${code} (expires in 10 minutes)` };
}

module.exports = { configured, send, retryPending, licenseEmail, recoveryEmail, orderCreatedEmail, adminCodeEmail };
