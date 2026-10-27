// All settings come from environment variables (set them in your host's dashboard, never in code).
const env = process.env;

function required(name, fallbackForDev) {
  const v = env[name];
  if (v && v.trim()) return v.trim();
  if (env.NODE_ENV !== "production" && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required setting ${name}. Add it in your hosting dashboard (Environment).`);
}

const config = {
  production: env.NODE_ENV === "production",
  port: +(env.PORT || 3000),
  // Public address of this website, e.g. https://polyrider-store.onrender.com (no slash at the end).
  // On Render this is filled in automatically (RENDER_EXTERNAL_URL) unless you set PUBLIC_URL.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ""),
  // Long random secret used to sign links and protect license keys. Never share it.
  serverSecret: required("SERVER_SECRET", "dev-only-secret-change-me-dev-only-secret"),

  // Database: Turso (libSQL) in production, a local file when testing
  dbUrl: env.DATABASE_URL || "file:polyrider.db",
  dbToken: env.DATABASE_AUTH_TOKEN || undefined,

  // Admin login
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || "",

  // Product
  productName: env.PRODUCT_NAME || "PolyRider BTC 5m",
  priceUsd: +(env.PRICE_USD || 29.99),
  supportEmail: env.SUPPORT_EMAIL || env.ADMIN_EMAIL || "",

  // Bitcoin
  btcAddress: (env.BTC_ADDRESS || "").trim(), // legacy setting
  cashAppTag: (env.CASH_APP_TAG || "").trim().replace(/^\$/, ""), // Cash App $cashtag, configured in hosting environment
  mempoolApi: (env.MEMPOOL_API || "https://mempool.space/api").replace(/\/+$/, ""),
  priceApiOverride: env.PRICE_API_OVERRIDE || "", // tests only
  quoteMinutes: +(env.QUOTE_MINUTES || 30),
  confirmationsRequired: +(env.CONFIRMATIONS_REQUIRED || 1),

  // Email (Brevo HTTP API — free plan). Optional: without it, codes show in the admin panel to copy.
  brevoKey: env.BREVO_API_KEY || "",
  emailFrom: env.EMAIL_FROM || "",
  emailFromName: env.EMAIL_FROM_NAME || "PolyRider",
  emailCaptureFile: env.EMAIL_CAPTURE_FILE || "", // tests only: write emails to a file instead of sending

  // Licensing
  licenseOfflineGraceHours: +(env.LICENSE_OFFLINE_GRACE_HOURS || 72),
  licenseRecheckMinutes: +(env.LICENSE_RECHECK_MINUTES || 60),
};

if (config.production) {
  if (config.serverSecret.length < 32) throw new Error("SERVER_SECRET must be at least 32 characters.");
  if (!config.adminEmail) throw new Error("Missing ADMIN_EMAIL.");
  if (!config.publicUrl.startsWith("https://")) throw new Error("PUBLIC_URL must start with https://");
  if (config.dbUrl.startsWith("file:") && env.ALLOW_FILE_DB !== "1")
    throw new Error("Missing DATABASE_URL. On free hosting a local database file is erased on every restart — connect Turso (see the setup guide).");
}

module.exports = config;
