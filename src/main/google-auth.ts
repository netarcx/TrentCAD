import http from 'http'
import { URL } from 'url'
import { shell, app } from 'electron'
import { OAuth2Client } from 'google-auth-library'
import { getGoogleAuthSettings, setGoogleAuthSettings } from './config'
import type { GoogleAuthStatus } from '@shared/types'

declare const __GOOGLE_CLIENT_ID__: string
declare const __GOOGLE_CLIENT_SECRET__: string

// Desktop OAuth credentials — set via environment variables or embed here
// after creating credentials in Google Cloud Console.
// Google explicitly documents that desktop app client secrets are not
// confidential (they ship inside the binary), so embedding is fine.
const CLIENT_ID =
  (typeof __GOOGLE_CLIENT_ID__ !== 'undefined' ? __GOOGLE_CLIENT_ID__ : '') ||
  process.env.GOOGLE_CLIENT_ID ||
  ''
const CLIENT_SECRET =
  (typeof __GOOGLE_CLIENT_SECRET__ !== 'undefined' ? __GOOGLE_CLIENT_SECRET__ : '') ||
  process.env.GOOGLE_CLIENT_SECRET ||
  ''
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
  'profile'
]

let oauthClient: OAuth2Client | null = null
let cachedStatus: GoogleAuthStatus = { signedIn: false }

function createBaseClient(): OAuth2Client {
  return new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
}

async function restoreFromDisk(): Promise<void> {
  if (oauthClient) return
  const stored = await getGoogleAuthSettings()
  if (!stored) return
  const client = createBaseClient()
  client.setCredentials({ refresh_token: stored.refreshToken })
  oauthClient = client
  cachedStatus = { signedIn: true, email: stored.email, name: stored.name }
}

export async function googleAuthStatus(): Promise<GoogleAuthStatus> {
  await restoreFromDisk()
  return cachedStatus
}

export async function getAuthClient(): Promise<OAuth2Client | null> {
  await restoreFromDisk()
  return oauthClient
}

export async function googleSignIn(): Promise<GoogleAuthStatus> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.'
    )
  }

  const { code, redirectUri } = await listenForAuthCode()

  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri
  })

  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Please revoke FrameCAD access at https://myaccount.google.com/permissions and try again.')
  }
  client.setCredentials(tokens)

  const userInfo = await fetchUserInfo(client).catch(() => ({ email: '', name: '' }))

  await setGoogleAuthSettings({
    refreshToken: tokens.refresh_token,
    email: userInfo.email,
    name: userInfo.name
  })

  oauthClient = client
  cachedStatus = { signedIn: true, email: userInfo.email, name: userInfo.name }
  return cachedStatus
}

export async function googleSignOut(): Promise<void> {
  if (oauthClient) {
    try {
      const token = oauthClient.credentials.access_token
      if (token) await oauthClient.revokeToken(token)
    } catch { /* best effort — token may already be expired */ }
  }
  oauthClient = null
  cachedStatus = { signedIn: false }
  await setGoogleAuthSettings(null)
}

/**
 * Mark the stored Google auth as invalid after the API rejected our token
 * (401 / invalid_grant — refresh token revoked or expired). Drops the dead
 * credentials so a status poll won't resurrect a "signed in" state from disk
 * and the UI prompts a fresh sign-in. No revoke call — the token is already
 * dead — and no thrown errors so it's safe to call from a transfer retry path.
 */
export async function markAuthInvalid(): Promise<void> {
  oauthClient = null
  cachedStatus = { signedIn: false }
  await setGoogleAuthSettings(null).catch(() => {})
}

async function fetchUserInfo(
  client: OAuth2Client
): Promise<{ email: string; name: string }> {
  const token = await client.getAccessToken()
  const accessToken = typeof token === 'string' ? token : token.token
  if (!accessToken) return { email: '', name: '' }

  // Bound the request so a network stall during sign-in can't hang the main
  // process. The callers already treat a failure as "no profile" and proceed.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let res: Response
  try {
    res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    })
  } catch {
    return { email: '', name: '' }
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) return { email: '', name: '' }
  const data = await res.json() as { email?: string; name?: string }
  return {
    email: data.email ?? '',
    name: data.name ?? ''
  }
}

/**
 * Start a temporary localhost HTTP server, open the Google consent screen
 * in the system browser, and wait for the redirect with the auth code.
 */
function listenForAuthCode(): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost`)
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Sign-in cancelled.</h2><p>You can close this tab.</p></body></html>')
          server.close()
          reject(new Error(`Google sign-in denied: ${error}`))
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Missing auth code.</h2></body></html>')
          return
        }

        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body>' +
          '<h2>Signed in to FrameCAD!</h2>' +
          '<p>You can close this tab and return to FrameCAD.</p>' +
          '<script>window.close()</script>' +
          '</body></html>'
        )
        server.close()
        resolve({ code, redirectUri: `http://localhost:${port}` })
      } catch (err) {
        server.close()
        reject(err)
      }
    })

    // Bind to port 0 to let the OS pick a free port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const redirectUri = `http://localhost:${port}`

      const client = new OAuth2Client({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri
      })

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
      })

      shell.openExternal(authUrl).catch(reject)
    })

    server.on('error', reject)

    // Timeout after 5 minutes — user abandoned the flow
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Google sign-in timed out. Please try again.'))
    }, 5 * 60 * 1000)

    server.on('close', () => clearTimeout(timeout))
  })
}
