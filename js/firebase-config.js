// ============================================================
// LuminaGrid — Firebase Configuration
// ============================================================
// Replace the placeholder values below with your actual Firebase
// project credentials (Firebase Console > Project Settings > General
// > Your apps > SDK setup and configuration).
//
// This file is loaded first on every page (see <script> order in
// each .html file) so `firebase` is initialized before auth.js,
// dashboard.js, or analytics.js run.
// ============================================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Not yet called. Every page currently reads through data-service.js,
// which pulls from data/mock-nodes.json instead of Firebase. Once
// hardware exists and a real Firebase project is ready, uncomment
// the three lines below and rewrite the internals of the functions
// in data-service.js to use `db.ref(...)` — no other file needs to
// change, since dashboard.js, energy-analytics.js, node-management.js,
// user-management.js, fault-records.js, and system-logs.js all call
// DataService only.
//
// firebase.initializeApp(firebaseConfig);
// const auth = firebase.auth();
// const db = firebase.database();

// Realtime Database path convention to match once wired in
// (mirrors the object-keyed shape data-service.js already expects):
// /streetlights/{streetlight_id}
// /sensor_readings/{streetlight_id}/{reading_id}
// /fault_reports/{fault_id}
// /maintenance_records/{maintenance_id}
// /notifications/{notification_id}
// /users/{user_id}
