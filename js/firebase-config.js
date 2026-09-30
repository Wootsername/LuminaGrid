// ============================================================
// LuminaGrid - Firebase Configuration
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDkL1rCo1ZcteEx0YV323FjxQXgQyW25cg",

  authDomain:
    "luminagrid-cf8c4.firebaseapp.com",

  databaseURL:
    "https://luminagrid-cf8c4-default-rtdb.asia-southeast1.firebasedatabase.app",

  projectId:
    "luminagrid-cf8c4",

  storageBucket:
    "luminagrid-cf8c4.firebasestorage.app",

  messagingSenderId:
    "919861466870",

  appId:
    "1:919861466870:web:9096240183c226c9743ed7"
};


// Initialize Firebase
firebase.initializeApp(firebaseConfig);


// Firebase services
const auth = firebase.auth();
const db = firebase.database();

console.log("LuminaGrid Firebase initialized.");