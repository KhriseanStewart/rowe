import { useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { firebaseReady, getFirebaseAuth } from '../lib/firebase'

export type FirebaseAuthState = {
  user: User | null
  loading: boolean
}

export function useFirebaseUser(): FirebaseAuthState {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => firebaseReady())

  useEffect(() => {
    if (!firebaseReady()) {
      setLoading(false)
      return
    }
    setLoading(true)
    return onAuthStateChanged(getFirebaseAuth(), (next) => {
      setUser(next)
      setLoading(false)
    })
  }, [])

  return { user, loading }
}
