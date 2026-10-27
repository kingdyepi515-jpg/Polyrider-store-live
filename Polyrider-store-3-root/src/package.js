// Checks uploaded extension releases, and builds each customer's personal download ZIP.
const AdmZip = require("adm-zip");
const crypto = require("crypto");
const config = require("./config");

const SERVER_PH = "__POLYRIDER_SERVER__";
const KEY_PH = "__POLYRIDER_PRESET_KEY__";
const VERSION_RE = /^\d{1,5}(\.\d{1,5}){0,3}$/;

function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// read the files of a release zip, wherever the manifest.json is inside it
function readRelease(buf) {
  let zip;
  try { zip = new AdmZip(buf); } catch { throw new Error("That file is not a valid ZIP."); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.entryName));
  const manifests = entries.filter((e) => /(^|\/)manifest\.json$/.test(e.entryName)).sort((a, b) => a.entryName.length - b.entryName.length);
  if (!manifests.length) throw new Error("The ZIP has no manifest.json. Zip the extension folder itself.");
  const root = manifests[0].entryName.replace(/manifest\.json$/, "");
  const files = {};
  for (const e of entries) {
    if (!e.entryName.startsWith(root)) continue;
    const rel = e.entryName.slice(root.length);
    if (rel.includes("..") || rel.startsWith("/")) throw new Error("The ZIP contains an unsafe file path.");
    files[rel] = e.getData();
  }
  return files;
}

function validateRelease(buf, currentVersion) {
  if (buf.length > 5 * 1024 * 1024) throw new Error("The ZIP is bigger than 5 MB.");
  const files = readRelease(buf);
  let m;
  try { m = JSON.parse(files["manifest.json"].toString("utf8")); } catch { throw new Error("manifest.json is not valid JSON."); }
  const problems = [];
  if (m.manifest_version !== 3) problems.push("manifest_version must be 3.");
  if (!VERSION_RE.test(String(m.version || ""))) problems.push("manifest version must look like 4.3.0.");
  if (currentVersion && VERSION_RE.test(String(m.version)) && cmpVersion(m.version, currentVersion) <= 0)
    problems.push(`Version ${m.version} must be higher than the current release ${currentVersion}.`);
  for (const f of ["license.js", "gate.js", "content.js"]) if (!files[f]) problems.push(`${f} is missing (the licensed build needs it).`);
  if (files["license.js"] && !files["license.js"].toString().includes(SERVER_PH)) problems.push("license.js is missing the server placeholder — use the licensed build of the extension.");
  if (!JSON.stringify(m.host_permissions || []).includes(SERVER_PH)) problems.push("manifest.json host_permissions is missing the server placeholder.");
  const cs = (m.content_scripts || [])[0];
  if (!cs || cs.js[0] !== "gate.js") problems.push("gate.js must load first in content_scripts.");
  for (const [name, data] of Object.entries(files)) {
    if (/\.(js|json|html)$/.test(name) && /(SERVER_SECRET|ADMIN_PASSWORD|BREVO_API_KEY|DATABASE_AUTH_TOKEN|-----BEGIN)/.test(data.toString("utf8")))
      problems.push(`${name} seems to contain a secret — remove it.`);
    if (/\.(exe|dll|so|dylib|sh|bat|cmd|ps1|app|pkg|dmg)$/i.test(name)) problems.push(`${name} is a program file — not allowed in an extension package.`);
  }
  if (problems.length) throw new Error(problems.join(" "));
  return { version: m.version, files, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

// Make one customer's ZIP: fills in this store's address and their license key.
function buildCustomerZip(releaseBuf, licenseKey) {
  const files = readRelease(releaseBuf);
  const m = JSON.parse(files["manifest.json"].toString("utf8"));
  const folder = `PolyRider-BTC-5m-v${m.version}/`;
  const out = new AdmZip();
  for (const [name, data] of Object.entries(files)) {
    let d = data;
    if (name === "license.js" || name === "manifest.json") {
      d = Buffer.from(d.toString("utf8").split(SERVER_PH).join(config.publicUrl).split(KEY_PH).join(licenseKey || ""), "utf8");
    }
    out.addFile(folder + name, d);
  }
  return { buf: out.toBuffer(), filename: `PolyRider-BTC-5m-v${m.version}.zip`, version: m.version };
}

module.exports = { validateRelease, buildCustomerZip, cmpVersion, SERVER_PH, KEY_PH };
