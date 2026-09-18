import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { defineSecret } from 'firebase-functions/params'
import { auth } from 'firebase-functions/v1'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

const githubClientId = defineSecret('GITHUB_CLIENT_ID')
const githubClientSecret = defineSecret('GITHUB_CLIENT_SECRET')

const app = initializeApp()
const db = getFirestore(app, 'rowe')

export const onRoweUserCreated = auth.user().onCreate(async (user) => {
  await db.doc(`users/${user.uid}`).set(
    {
      email: user.email ?? null,
      name: user.displayName ?? null,
      photo: user.photoURL ?? null,
      firstSeenAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      sessionCount: 0
    },
    { merge: true }
  )
})

export const rollupPresence = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1' },
  async () => {
    const now = Date.now()
    const [active5m, active24h, users] = await Promise.all([
      countSince(now - 5 * 60 * 1000),
      countSince(now - 24 * 60 * 60 * 1000),
      db.collection('users').count().get()
    ])

    await db.doc('stats/presence').set({
      activeLast5m: active5m,
      activeLast24h: active24h,
      users: users.data().count,
      updatedAt: FieldValue.serverTimestamp()
    })
  }
)

export const githubExchange = onRequest(
  {
    region: 'us-central1',
    cors: true,
    secrets: [githubClientId, githubClientSecret]
  },
  async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }

  const clientId = githubClientId.value().trim()
  const clientSecret = githubClientSecret.value().trim()
  if (!clientId || !clientSecret) {
    res.status(501).json({ error: 'GitHub OAuth is not configured on functions' })
    return
  }

  const code = typeof req.body?.code === 'string' ? req.body.code : ''
  const redirectUri = typeof req.body?.redirectUri === 'string' ? req.body.redirectUri : ''
  if (!code || !redirectUri) {
    res.status(400).json({ error: 'code and redirectUri are required' })
    return
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  })
  const payload = (await response.json()) as { access_token?: string; error?: string }
  if (!payload.access_token) {
    res.status(400).json({ error: payload.error || 'GitHub did not return an access token' })
    return
  }
  res.json({ token: payload.access_token })
})


async function countSince(millis: number): Promise<number> {
  const snapshot = await db
    .collection('users')
    .where('lastActiveAt', '>', Timestamp.fromMillis(millis))
    .count()
    .get()
  return snapshot.data().count
}
