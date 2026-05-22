import { useEffect, useState } from 'react'
import {
  HashRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom'
import SignIn from './pages/SignIn'
import Dashboard from './pages/Dashboard'
import Members from './pages/Members'
import Pins from './pages/Pins'
import Projects from './pages/Projects'
import TeamSettings from './pages/TeamSettings'
import Logs from './pages/Logs'
import Wizard from './pages/Wizard'
import { api, ApiError } from './api'
import { clearSession, getMember, getToken } from './auth'

/**
 * Top-level router.
 *
 * HashRouter so the SPA works without server-side rewrites — the
 * Fastify side only serves index.html and the built assets, so hash
 * routes keep everything client-side after that.
 *
 * Auth gate: AdminShell verifies the token via /api/me, redirects to
 * /sign-in on 401, and renders the side-nav layout with its child
 * routes via <Outlet/>.
 */
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        {/* Wizard is auth-gated but renders without the side-nav
            shell — it's a focused first-launch flow. AdminShell
            redirects to it when /api/admin/setup-state says we're
            not done. */}
        <Route path="/setup" element={<WizardGate />} />
        <Route element={<AdminShell />}>
          <Route index element={<Dashboard />} />
          <Route path="members" element={<Members />} />
          <Route path="pins" element={<Pins />} />
          <Route path="projects" element={<Projects />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<TeamSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

/**
 * Thin wrapper around the Wizard page — same auth gate as
 * AdminShell, but renders without the side-nav so the wizard is
 * focused and full-screen. Bouncing here when the user lands on
 * /setup directly while not signed in.
 */
function WizardGate() {
  const navigate = useNavigate()
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const token = getToken()
    const m = getMember()
    if (!token || !m || m.role !== 'admin') {
      navigate('/sign-in', { replace: true })
      return
    }
    setOk(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!ok) return null
  return <Wizard />
}

function AdminShell() {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const member = getMember()

  useEffect(() => {
    const token = getToken()
    const m = getMember()
    if (!token || !m || m.role !== 'admin') {
      navigate('/sign-in', { replace: true })
      return
    }
    // Sanity-check the token by hitting /api/me. If the server has
    // revoked us (admin removed the device elsewhere), a 401 here
    // kicks back to sign-in. Network errors fall through silently;
    // the cached member info is enough to render the shell.
    api('GET', '/api/me')
      .then(async () => {
        // Once we know the token is good, see whether the first-launch
        // wizard still wants attention. If so, hop over to /setup —
        // the wizard itself decides which step to start on. Bail
        // silently on error (a transient blip shouldn't trap the
        // admin in a loading screen).
        try {
          const s = await api<{ setupComplete: boolean }>(
            'GET', '/api/admin/setup-state'
          )
          if (!s.setupComplete) {
            navigate('/setup', { replace: true })
            return
          }
        } catch { /* ignore — show the dashboard */ }
        setChecking(false)
      })
      .catch(err => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession()
          navigate('/sign-in', { replace: true })
        } else {
          setChecking(false)
        }
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function signOut(): void {
    clearSession()
    navigate('/sign-in', { replace: true })
  }

  if (checking) {
    return <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading…</div>
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">FrameCAD</div>
        <div className="sidebar-section">Team</div>
        <NavLink to="/" end className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Dashboard</NavLink>
        <NavLink to="/members" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Members</NavLink>
        <NavLink to="/pins" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>PINs</NavLink>
        <NavLink to="/projects" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Projects</NavLink>
        <NavLink to="/logs" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Logs</NavLink>
        <NavLink to="/settings" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Settings</NavLink>
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          {/* Robust fallback chain — even if a legacy member still has
              the placeholder `displayName='Unnamed member'` (set by
              the server when enrollment didn't carry a name, common
              for the bootstrap-PIN admin), show their GitHub handle
              if available so the sidebar isn't literally "Signed in
              as Unnamed member". The set-password flow now upgrades
              displayName at first claim so this is a safety net for
              old data, not the primary path. */}
          Signed in as <strong>
            {member?.displayName && member.displayName !== 'Unnamed member'
              ? member.displayName
              : member?.githubUsername
                ? '@' + member.githubUsername
                : 'admin'}
          </strong>
          <br />
          <button onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
