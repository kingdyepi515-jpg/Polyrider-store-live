// Builds the licensed extension from the ORIGINAL PolyRider files with the smallest possible changes,
// then zips it for the store.  Usage:  node scripts/build-release.js [version]
//   - extension-original/   your untouched PolyRider files (manifest.json, content.js)
//   - extension/            gate.js + license.js (the only new files), plus the patched copies written here
//   - release-seed/         the ZIP the store publishes on first start (or that you upload in Admin → Versions)
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const root = path.join(__dirname, "..");
const orig = path.join(root, "extension-original");
const out = path.join(root, "extension");
const version = process.argv[2] || "4.3.0";

function patch(text, from, to, file) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected exactly 1 match for ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.replace(from, to);
}

// 1) manifest.json: new version, license server permission, background license check, gate.js first
const m = JSON.parse(fs.readFileSync(path.join(orig, "manifest.json"), "utf8"));
m.version = version;
m.host_permissions = [...m.host_permissions, "__POLYRIDER_SERVER__/*"];
m.background = { service_worker: "license.js" };
m.content_scripts[0].js = ["gate.js", ...m.content_scripts[0].js];
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

// 2) content.js: only (a) the version label and (b) wait for the license gate before starting
let c = fs.readFileSync(path.join(orig, "content.js"), "utf8");
c = patch(c, 'const VER = "4.2.0";', `const VER = chrome.runtime.getManifest().version;`, "content.js");
c = patch(c, '  chrome.storage.local.get(["pr_set", "pr_day"], (r) => {', '  window.__prGate(() => chrome.storage.local.get(["pr_set", "pr_day"], (r) => { // licensed start', "content.js");
c = patch(c, "    setInterval(tick, 500);\n  });\n})();", "    setInterval(tick, 500);\n  }));\n})();", "content.js");
fs.writeFileSync(path.join(out, "content.js"), c);

// 3) zip it
const zip = new AdmZip();
for (const f of ["manifest.json", "gate.js", "license.js", "content.js"]) zip.addFile(f, fs.readFileSync(path.join(out, f)));
const seedDir = path.join(root, "release-seed");
fs.mkdirSync(seedDir, { recursive: true });
for (const f of fs.readdirSync(seedDir)) if (f.endsWith(".zip")) fs.unlinkSync(path.join(seedDir, f));
const zipPath = path.join(seedDir, `polyrider-btc-5m-${version}.zip`);
zip.writeZip(zipPath);
console.log("Built", zipPath);
