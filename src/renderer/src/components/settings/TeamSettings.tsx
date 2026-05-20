import { useState, useEffect } from 'react'
import type { GlobalAdminConfig, GlobalAdminState } from '@shared/types'
import { useCoordState, forceRefreshCoordState, invalidateCoordState } from '../../hooks/useCoordState'
import ErrorMsg from '../ErrorMsg'

export default function TeamSettings() {
  const [globalState, setGlobalState] = useState<GlobalAdminState | null>(null)
  const [form, setForm] = useState<GlobalAdminConfig>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  // Shared coord-state cache — no longer triggers our own git-pull
  // every time the tab opens.
  const { state: cachedCoord, loading: coordLoading } = useCoordState()
  const coordState = cachedCoord ?? { configured: false }

  useEffect(() => {
    window.api.getGlobalAdmin()
      .then(state => {
        setGlobalState(state)
        setForm(state.effective)
      })
      .catch(() => {})
  }, [])

  const refreshCoord = async () => {
    setError(null)
    try { await forceRefreshCoordState() }
    catch (err) { setError((err as Error).message) }
  }

  const set = <K extends keyof GlobalAdminConfig>(key: K, value: GlobalAdminConfig[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await window.api.saveGlobalAdmin(form)
      const fresh = await window.api.getGlobalAdmin()
      setGlobalState(fresh)
      setForm(fresh.effective)
      setStatus('Saved locally. This computer keeps these values across updates.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setError(null)
    setStatus(null)
    try {
      await window.api.resetGlobalAdmin()
      const fresh = await window.api.getGlobalAdmin()
      setGlobalState(fresh)
      setForm(fresh.effective)
      setStatus('Reset to team defaults shipped with this install.')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect from the coordination repo? You can reconnect later from the welcome screen.')) return
    setError(null)
    try {
      await window.api.disconnectCoordinationRepo()
      // Drop the cache — the repo we were just connected to is no
      // longer relevant; force the next consumer to re-fetch.
      invalidateCoordState()
      await refreshCoord()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!globalState) return null

  const overrideStatusLine = globalState.hasLocalOverride
    ? 'Showing your local overrides. These survive app updates until you Reset.'
    : 'Showing team defaults shipped with this install.'

  return (
    <>
      {coordState.configured && (
        <div className="admin-section">
          <h3>Coordination Repo</h3>
          <p className="admin-hint" style={{ wordBreak: 'break-all' }}>
            {coordState.repoUrl}
          </p>
          {coordState.lastSyncAt && (
            <p className="admin-hint" style={{ opacity: 0.6 }}>
              Last synced: {new Date(coordState.lastSyncAt).toLocaleString()}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="toolbar-btn" onClick={refreshCoord} disabled={coordLoading}>
              {coordLoading ? 'Syncing...' : 'Sync Now'}
            </button>
            <button className="toolbar-btn" onClick={handleDisconnect} style={{ color: 'var(--red)' }}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      <p className="admin-warning">
        Team and GitHub Browse settings are saved on this computer only.
        {' '}{overrideStatusLine}
      </p>

      <div className="admin-section">
        <h3>Team</h3>
        <label>Team name</label>
        <input
          value={form.teamName ?? ''}
          onChange={e => set('teamName', e.target.value)}
          placeholder={globalState.defaults.teamName || 'FRC Team 2129'}
        />
        <label>Welcome message</label>
        <textarea
          value={form.welcomeMessage ?? ''}
          onChange={e => set('welcomeMessage', e.target.value)}
          placeholder={globalState.defaults.welcomeMessage || 'Optional message shown to teammates'}
          rows={2}
        />
      </div>

      <div className="admin-section">
        <h3>GitHub Browse</h3>
        <p className="admin-hint">
          When set, students see a "Browse Projects" button on the welcome
          screen listing repos in this organisation that match the prefix.
          New projects use the prefix automatically.
        </p>
        <label>GitHub organisation</label>
        <input
          value={form.gitHubOrg ?? ''}
          onChange={e => set('gitHubOrg', e.target.value)}
          placeholder={globalState.defaults.gitHubOrg || 'netarcx'}
        />
        <label>Project name prefix</label>
        <input
          value={form.projectPrefix ?? ''}
          onChange={e => set('projectPrefix', e.target.value)}
          placeholder={globalState.defaults.projectPrefix || 'framecad-'}
        />
      </div>

      <div className="admin-section-actions">
        <button
          className="toolbar-btn"
          onClick={handleReset}
          disabled={saving || !globalState.hasLocalOverride}
          title={globalState.hasLocalOverride
            ? 'Discard local overrides and use the team defaults shipped with this install'
            : 'No local overrides to reset'}
        >
          Reset to team defaults
        </button>
        <button className="toolbar-btn primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save (local)'}
        </button>
      </div>

      {error && <ErrorMsg text={error} />}
      {status && <div className="admin-status">{status}</div>}
    </>
  )
}
