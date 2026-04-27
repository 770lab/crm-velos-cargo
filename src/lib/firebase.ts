import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(firebaseApp);

// Persistance offline IndexedDB : les lectures sont mises en cache et les
// écritures sont queuées localement quand le réseau coupe (4G instable
// terrain), puis synchronisées au reconnect. Évite les pertes de scans
// FNUCI / photos montage si le préparateur/chauffeur perd brièvement
// son réseau.
// initializeFirestore doit être appelé AVANT toute autre interaction avec
// la SDK : si déjà initialisé (cas du rechargement HMR Next.js), on tombe
// sur getFirestore qui réutilise l'instance existante.
function initFirestore(): Firestore {
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    // Déjà initialisé (HMR Next.js) ou IndexedDB indispo (Safari private
    // mode, navigateurs anciens) → fallback mémoire.
    return getFirestore(firebaseApp);
  }
}
export const db = initFirestore();
export const storage = getStorage(firebaseApp);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
