import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'
import {
  browserLocalPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth
} from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined
}

let app: FirebaseApp | undefined
let auth: Auth | undefined
let analytics: Analytics | undefined

export function firebaseReady(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)
}

export function getFirebaseApp(): FirebaseApp {
  if (!firebaseReady()) {
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* keys to .env.')
  }
  if (!app) {
    app = initializeApp(config)
  }
  return app
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = initializeAuth(getFirebaseApp(), {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence]
    })
  }
  return auth
}

export function getFirebaseDb(): Firestore {
  // Firestore is deprecated for app data — Postgres is the source of truth.
  // Kept only for any leftover tooling; prefer window.api user APIs.
  return getFirestore(getFirebaseApp(), 'rowe')
}

export async function getFirebaseAnalytics(): Promise<Analytics | undefined> {
  if (!firebaseReady() || analytics) {
    return analytics
  }
  if (await isSupported()) {
    analytics = getAnalytics(getFirebaseApp())
  }
  return analytics
}
