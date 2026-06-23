import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
} from "firebase/firestore";

// Your web app's Firebase configuration (from Firebase console)
const firebaseConfig = {
  apiKey: "AIzaSyAdNIaYkwHf5eAQ-FfRr7erpkMiDUuLfBU",
  authDomain: "tidraiwa.firebaseapp.com",
  projectId: "tidraiwa",
  storageBucket: "tidraiwa.firebasestorage.app",
  messagingSenderId: "1033150705440",
  appId: "1:1033150705440:web:57411bbc0a623d638fb145",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// All "shared" data (traffic reports, user backups) lives in one Firestore
// collection so every browser that loads this app reads/writes the same
// documents. Firestore documents are identified by their key (no separate
// "shared" vs "private" concept like the old artifact storage had — see
// firestore.rules for the actual access boundary).
const COLLECTION = "tidraiwa_data";

// Mimics the artifact's window.storage API shape (get/set/delete/list) so the
// rest of the app's logic barely had to change when moving off the artifact
// platform. `shared` parameter is ignored here — in this Firebase version,
// everything written through this wrapper is shared by definition (all
// clients hit the same Firestore collection). Per-device-only data (e.g. the
// "remember this device already registered" flag) still uses plain
// localStorage elsewhere in the app, untouched by this file.
export const storage = {
  async get(key) {
    const snap = await getDoc(doc(db, COLLECTION, key));
    if (!snap.exists()) return null;
    return { key, value: snap.data().value, shared: true };
  },
  async set(key, value) {
    await setDoc(doc(db, COLLECTION, key), { value, updatedAt: Date.now() });
    return { key, value, shared: true };
  },
  async delete(key) {
    await deleteDoc(doc(db, COLLECTION, key));
    return { key, deleted: true, shared: true };
  },
  async list(prefix = "") {
    // Firestore has no native "key starts with" query for document IDs, so
    // we fetch the whole collection and filter client-side. This is fine for
    // a small prototype's data volume; a high-traffic version would want a
    // dedicated indexed field instead of relying on document ID prefixes.
    const snap = await getDocs(collection(db, COLLECTION));
    const keys = [];
    snap.forEach((d) => {
      if (d.id.startsWith(prefix)) keys.push(d.id);
    });
    return { keys, prefix, shared: true };
  },
};
