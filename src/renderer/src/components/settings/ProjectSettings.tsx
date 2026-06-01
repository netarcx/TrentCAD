import { useState, useEffect } from 'react'
import type { AdminConfig } from '@shared/types'
import ErrorMsg from '../ErrorMsg'

export default function ProjectSettings() {
  const [config, setConfig] = useState<AdminConfig>({})
  const [saving, setSaving] = useState(false)
  const [legacyMode, setLegacyMode] = useState(false)
  const [legacyToggling, setLegacyToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    window.api.getAdminConfig()
      .then(c => setConfig(c || {}))
      .catch(() => setConfig({}))
    window.api.getPartsManifest()
      .then(m => setLegacyMode(!!m?.legacyMode))
      .catch(() => {})
  }, [])

  const set = <K extends keyof AdminConfig>(key: K, value: AdminConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      const cleaned: AdminConfig = {}
      ;(Object.keys(config) as (keyof AdminConfig)[]).forEach(key => {
        const v = config[key]
        if (typeof v === 'string' && v.trim() === '') return
        ;(cleaned as Record<string, unknown>)[key] = v
      })
      await window.api.saveAdminConfig(cleaned)
      setStatus('Saved to the project. Teammates will see this on next sync.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleLegacy = async (next: boolean) => {
    setLegacyToggling(true)
    setError(null)
    setStatus(null)
    try {
      await window.api.setLegacyMode(next)
      setLegacyMode(next)
      setStatus(next
        ? 'Legacy mode on — new files will use their filename as the part number. Existing part numbers were not changed.'
        : 'Legacy mode off — new files will use the auto-numbered scheme. Existing part numbers were not changed.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLegacyToggling(false)
    }
  }

  return (
    <>
      <p className="admin-warning">
        These settings are saved to <em>this project</em> on Save. Every
        teammate picks them up on their next sync.
      </p>

      <div className="admin-section">
        <h3>Project Layout</h3>
        <label>Project subfolder</label>
        <input
          value={config.projectSubpath ?? ''}
          onChange={e => set('projectSubpath', e.target.value)}
          placeholder='e.g. "2026 Rebuilt"'
        />
        <p className="admin-hint">
          When set, FrameCAD treats this subfolder of the repo as the
          project root — the file tree only shows files inside it, and
          new parts are created there by default. Leave blank if the
          repo root is your project. Use forward slashes; no leading or
          trailing slash. <strong>Empty = repo root (the default).</strong>
        </p>
        <label>COTS subfolder (optional)</label>
        <input
          value={config.cotsSubpath ?? ''}
          onChange={e => set('cotsSubpath', e.target.value)}
          placeholder='e.g. "COTS"'
        />
        <p className="admin-hint">
          A sibling subfolder in this project holding commercial
          off-the-shelf parts. Setting this hides it from the project file
          tree.
        </p>
      </div>

      <div className="admin-section">
        <h3>Part Numbering</h3>
        <label>Default part-number prefix</label>
        <input
          value={config.defaultPartPrefix ?? ''}
          onChange={e => set('defaultPartPrefix', e.target.value)}
          placeholder="e.g. 26-2129"
        />
        <p className="admin-hint">
          Stays with this project. Used by the auto-numbering when creating
          new parts and assemblies.
        </p>
        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={legacyMode}
            onChange={e => handleToggleLegacy(e.target.checked)}
            disabled={legacyToggling}
          />
          <span>Legacy mode (use filenames as part numbers)</span>
        </label>
        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={!!config.hideMass}
            onChange={e => set('hideMass', e.target.checked || undefined)}
          />
          <span>Hide robot weight / mass display</span>
        </label>
        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={!!config.hideCost}
            onChange={e => set('hideCost', e.target.checked || undefined)}
          />
          <span>Hide robot cost display</span>
        </label>
        <p className="admin-hint">
          Hides the mass / cost rollups in the status bar and
          omits them from generated documents. The underlying
          per-part values stay in <code>parts-meta.json</code>;
          just turn the toggle back off to reveal them again.
        </p>
      </div>

      <div className="admin-section-actions">
        <button className="toolbar-btn primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save project settings & Upload'}
        </button>
      </div>

      {error && <ErrorMsg text={error} />}
      {status && <div className="admin-status">{status}</div>}
    </>
  )
}
