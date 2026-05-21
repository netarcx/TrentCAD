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
        <Route element={<AdminShell />}>
          <Route index element={<Dashboard />} />
          <Route path="members" element={<Members />} />
          <Route path="pins" element={<Pins />} />
          <Route path="projects" element={<Projects />} />
          <Route path="settings" element={<TeamSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
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
      .then(() => setChecking(false))
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
    return <div style={{ padding: 30, color: '#737373' }}>Loading…</div>
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
        <NavLink to="/settings" className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>Settings</NavLink>
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          Signed in as <strong>{member?.displayName}</strong>
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
