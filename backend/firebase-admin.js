// ============================================================
// LuminaGrid backend — Firebase Admin SDK initialization
// ============================================================
// TRUSTED server-side access. Credentials are NEVER committed.
// Resolution order:
//   1. FIREBASE_SERVICE_ACCOUNT  env var containing the service-account JSON
//   2. GOOGLE_APPLICATION_CREDENTIALS env var (path) -> applicationDefault()
//   3. ./serviceAccountKey.json  (local file, gitignored)
// The database URL comes from FIREBASE_DATABASE_URL (falls back to project
// default). Private keys/tokens are never printed.
// ============================================================

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://luminagrid-cf8c4-default-rtdb.asia-southeast1.firebasedatabase.app";

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // JSON string passed directly in the environment.
    return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }
  const local = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(local)) {
    return admin.credential.cert(require(local)); // eslint-disable-line
  }
  throw new Error(
    "No Firebase Admin credentials found. Set FIREBASE_SERVICE_ACCOUNT (JSON), " +
      "GOOGLE_APPLICATION_CREDENTIALS (path), or add backend/serviceAccountKey.json (gitignored)."
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: loadCredential(),
    databaseURL: DATABASE_URL
  });
}

const db = admin.database();

module.exports = { admin, db, DATABASE_URL };
