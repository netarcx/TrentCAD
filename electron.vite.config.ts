import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Build-time defaults for the global admin settings (Team + Browse).
// Sourced from GH Actions secrets; local clients override these via the
// welcome-screen admin page, and their overrides survive app updates
// unless they explicitly Reset to team defaults.
const defGhOrg = JSON.stringify(process.env.FRAMECAD_DEFAULT_GITHUB_ORG || '')
// Default GitHub-repo prefix when no CI secret is set. Drives the
// Browse Projects filter and Create-on-GitHub naming. Forks override
// by setting FRAMECAD_DEFAULT_PROJECT_PREFIX. Existing local overrides
// from earlier versions persist — users on legacy `trentcad-` prefix
// keep that value until they click Reset in Admin → Team.
const defPrefix = JSON.stringify(process.env.FRAMECAD_DEFAULT_PROJECT_PREFIX || 'framecad-')
const defTeam = JSON.stringify(process.env.FRAMECAD_DEFAULT_TEAM_NAME || '')
const defWelcome = JSON.stringify(process.env.FRAMECAD_DEFAULT_WELCOME_MESSAGE || '')
// Forks point auto-bug-reports at their own repo via this var so
// upstream isn't flooded with team-specific issues. Falls back to the
// upstream tracker in app code when unset.
const defIssueRepo = JSON.stringify(process.env.FRAMECAD_DEFAULT_ISSUE_REPO || '')
// Pre-baked team-server URL. When set, an end user who pastes just a
// bare 6-character PIN (no full enrollment link) gets enrolled against
// this URL automatically — matches the kiosk-style "students never
// type the server hostname" deployment. The hard-coded fallback
// points at the FRC 2129 production server so default installer
// builds work out of the box; downstream forks override at build
// time by setting FRAMECAD_DEFAULT_SERVER_URL before `npm run package`.
const defServerUrl = JSON.stringify(
  process.env.FRAMECAD_DEFAULT_SERVER_URL || 'https://framecad.swrobotics.com'
)
// Google OAuth desktop credentials for the Drive backend. These are
// public-client credentials in a shipped desktop app, so they are not
// treated as confidential at runtime; CI injects them during build and
// local dev can still use .env / shell vars.
const googleClientId = JSON.stringify(process.env.GOOGLE_CLIENT_ID || '')
const googleClientSecret = JSON.stringify(process.env.GOOGLE_CLIENT_SECRET || '')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: {
      __FRAMECAD_DEFAULT_GITHUB_ORG__: defGhOrg,
      __FRAMECAD_DEFAULT_PROJECT_PREFIX__: defPrefix,
      __FRAMECAD_DEFAULT_TEAM_NAME__: defTeam,
      __FRAMECAD_DEFAULT_WELCOME_MESSAGE__: defWelcome,
      __FRAMECAD_DEFAULT_ISSUE_REPO__: defIssueRepo,
      __FRAMECAD_DEFAULT_SERVER_URL__: defServerUrl,
      __GOOGLE_CLIENT_ID__: googleClientId,
      __GOOGLE_CLIENT_SECRET__: googleClientSecret
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: {
      __FRAMECAD_DEFAULT_GITHUB_ORG__: defGhOrg,
      __FRAMECAD_DEFAULT_PROJECT_PREFIX__: defPrefix,
      __FRAMECAD_DEFAULT_TEAM_NAME__: defTeam,
      __FRAMECAD_DEFAULT_WELCOME_MESSAGE__: defWelcome,
      __FRAMECAD_DEFAULT_ISSUE_REPO__: defIssueRepo,
      __FRAMECAD_DEFAULT_SERVER_URL__: defServerUrl,
      __GOOGLE_CLIENT_ID__: googleClientId,
      __GOOGLE_CLIENT_SECRET__: googleClientSecret
    }
  }
})
