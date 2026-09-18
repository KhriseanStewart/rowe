import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { BrowserWindow } from 'electron'

const GITHUB_OAUTH_PORT = 8791

function githubEnv(name: 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GITHUB_EXCHANGE_URL'): string {
  return (process.env[name] ?? import.meta.env[name] ?? '').trim()
}

export function githubOAuthConfigured(): boolean {
  return Boolean(githubEnv('GITHUB_CLIENT_ID') && (githubEnv('GITHUB_CLIENT_SECRET') || githubEnv('GITHUB_EXCHANGE_URL')))
}

export async function signInWithGithubOAuth(): Promise<string> {
  const clientId = githubEnv('GITHUB_CLIENT_ID')
  const clientSecret = githubEnv('GITHUB_CLIENT_SECRET')
  const exchangeUrl = githubEnv('GITHUB_EXCHANGE_URL')
  if (!clientId || (!clientSecret && !exchangeUrl)) {
    throw new Error('GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and a secret or GITHUB_EXCHANGE_URL.')
  }

  const { waitForCode, close } = await listenForCode()
  const redirect = `http://127.0.0.1:${GITHUB_OAUTH_PORT}/callback`
  const authorize = new URL('https://github.com/login/oauth/authorize')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('scope', 'read:user repo')
  authorize.searchParams.set('redirect_uri', redirect)

  const window = new BrowserWindow({
    width: 480,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    title: 'Connect GitHub'
  })

  try {
    await window.loadURL(authorize.toString())
    const code = await Promise.race([
      waitForCode(),
      new Promise<string>((_, reject) => {
        window.on('closed', () => reject(new Error('GitHub sign-in was closed')))
      })
    ])
    if (!window.isDestroyed()) {
      window.close()
    }

    if (exchangeUrl) {
      const response = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri: redirect })
      })
      const payload = (await response.json()) as { token?: string; error?: string }
      if (!payload.token) {
        throw new Error(payload.error || 'GitHub exchange failed')
      }
      return payload.token
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
        redirect_uri: redirect
      })
    })
    const payload = (await response.json()) as { access_token?: string; error?: string }
    if (!payload.access_token) {
      throw new Error(payload.error || 'GitHub did not return an access token')
    }
    return payload.access_token
  } finally {
    close()
    if (!window.isDestroyed()) {
      window.close()
    }
  }
}

function listenForCode(): Promise<{
  waitForCode: () => Promise<string>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    let pending: ((code: string) => void) | undefined
    let received: string | undefined

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.statusCode = 404
        response.end()
        return
      }
      const code = url.searchParams.get('code')
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html')
      response.end('<p>You can close this window and return to Rowe.</p>')
      if (code) {
        if (pending) {
          pending(code)
        } else {
          received = code
        }
      }
    })

    const waitForCode = (): Promise<string> =>
      new Promise((done, fail) => {
        if (received) {
          done(received)
          return
        }
        pending = done
        setTimeout(() => fail(new Error('GitHub sign-in timed out')), 120_000)
      })

    server.listen(GITHUB_OAUTH_PORT, '127.0.0.1', () => {
      resolve({
        waitForCode,
        close: () => server.close()
      })
    })
    server.on('error', reject)
  })
}
