import { useState, useEffect, useCallback } from 'react'
import type { GlobalAdminConfig, GlobalAdminState, CoordinationState } from '@shared/types'
import ErrorMsg from '../ErrorMsg'

export default function TeamSettings() {
  const [globalState, setGlobalState] = useState<GlobalAdminState | null>(null)
  const [form, setForm] = useState<GlobalAdminConfig>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const [coordState, setCoordState] = useState<CoordinationState>({ configured: false })
  const [coordLoading, setCoordLoading] = useState(true)

  useEffect(() => {
    window.api.getGlobalAdmin()
      .then(state => {
        setGlobalState(state)
        setForm(state.effective)
      })
      .catch(() => {})
  }, [])

  const refreshCoord = useCallback(async () => {
    setCoordLoading(true)
    try {
      const state = await window.api.syncCoordinationRepo()
      setCoordState(state)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCoordLoading(false)
    }
  }, [])

  useEffect(() => { refreshCoord() }, [refreshCoord])

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
            <p className="admin-hint" style={{ fontSize: '0.75rem', opacity: 0.6 }}>
              Last synced: {new Date(coordState.lastSyncAt).toLocaleString()}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="toolbar-btn" onClick={refreshCoord} disabled={coordLoading}>
              {coordLoading ? 'Syncing...' : 'Sync Now'}
            </button>
            <button className="toolbar-btn" onClick={handleDisconnect} style={{ color: 'var(--color-danger, #ef4444)' }}>
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
