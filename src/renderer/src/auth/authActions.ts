import { signOut } from 'firebase/auth'
import { firebaseReady, getFirebaseAuth } from '../lib/firebase'

export function signOutRowe(): void {
  void window.api.clearUserSession().catch(() => undefined)
  if (firebaseReady()) {
    void signOut(getFirebaseAuth())
  }
}
