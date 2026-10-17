// Firebase wiring: anonymous auth + Firestore, read from Vite env vars so
// no secret ever needs to be hard-coded or committed. If those vars are
// absent (e.g. local dev before .env.local is set up), `isFirebaseConfigured`
// is false and store.js falls back to a localStorage-only adapter instead.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const env = import.meta.env || {};
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app = null;
let auth = null;
let db = null;
let anonReadyPromise = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export function getDb() {
  return db;
}

// Resolves once an anonymous user is signed in (or immediately if one
// already is). Every Firestore write waits on this, since the security
// rules key off request.auth.uid.
export function ensureAnonymousAuth() {
  if (!isFirebaseConfigured) return Promise.resolve(null);
  if (anonReadyPromise) return anonReadyPromise;

  anonReadyPromise = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user);
        }
      },
      reject
    );
    signInAnonymously(auth).catch((err) => {
      unsubscribe();
      reject(err);
    });
  });
  return anonReadyPromise;
}

export function getCurrentUid() {
  return auth?.currentUser?.uid ?? null;
}
