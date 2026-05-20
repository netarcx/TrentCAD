import { useState, useEffect } from 'react'
import type { AdminConfig } from '@shared/types'
import ErrorMsg from '../ErrorMsg'

export default function ProjectSettings() {
  const [config, setConfig] = useState<AdminConfig>({})
  const [saving, setSaving] = useState(false)
  const [syncingCots, setSyncingCots] = useState(false)
  const [taggingNow, setTaggingNow] = useState(false)
  const [tagName, setTagName] = useState(() => {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `progress-${yyyy}-${mm}-${dd}`
  })
  const [legacyMode, setLegacyMode] = useState(false)
  const [legacyToggling, setLegacyToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    window.api.getAdminConfig()
      .then(c => setConfig(c || {}))
      .catch(() => setConfig({}))
    window.api.getMainRemoteUrl().then(url => {
      if (url) setConfig(prev => ({ ...prev, mainRepoUrl: prev.mainRepoUrl || url }))
    }).catch(() => {})
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
      setStatus('Saved and pushed to git. Teammates will see this on next sync.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleCopyRepoUrl = async () => {
    setError(null)
    setStatus(null)
    const url = (config.mainRepoUrl || '').trim()
    if (!url) { setError('No Git URL to copy'); return }
    try {
      await navigator.clipboard.writeText(url)
      setStatus('Git URL copied to clipboard')
    } catch (err) {
      setError('Could not copy: ' + (err as Error).message)
    }
  }

  const handleCreateTag = async () => {
    setTaggingNow(true)
    setError(null)
    setStatus(null)
    try {
      const result = await window.api.createProgressTag(tagName)
      if (result.success) setStatus(`Tag "${tagName}" created and pushed`)
      else setError(result.error || 'Failed to create tag')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setTaggingNow(false)
    }
  }

  const handleSyncCots = async () => {
    setSyncingCots(true)
    setError(null)
    setStatus(null)
    try {
      const result = await window.api.syncCots()
      if (result.success) setStatus(result.cloned ? 'COTS repo cloned into COTS/' : 'COTS folder updated.')
      else setError(result.error || 'COTS sync failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncingCots(false)
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
        These settings are committed and pushed to <em>this project's</em>
        {' '}git repo on Save. Every teammate picks them up on their next sync.
      </p>

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

      <div className="admin-section">
        <h3>Main Repository</h3>
        <label>Git remote URL</label>
        <div className="inline-input-row">
          <input
            value={config.mainRepoUrl ?? ''}
            onChange={e => set('mainRepoUrl', e.target.value)}
            placeholder="https://github.com/org/main-project.git"
          />
          <button className="toolbar-btn" onClick={handleCopyRepoUrl}>Copy</button>
        </div>
        <p className="admin-hint">
          Saving rewrites this project's `origin` remote to match.
        </p>
      </div>

      <div className="admin-section">
        <h3>Self-Hosted LFS Storage <span className="admin-hint-inline">(advanced)</span></h3>
        <p className="admin-hint">
          By default, large CAD files are stored in GitHub's LFS.
          Set a URL here to redirect LFS storage to your own server
          (rudolfs, giftless, Gitea, GitLab, etc.) &mdash; git push/pull
          still go to GitHub, only the LFS object bytes change
          hosts. Leave blank to use GitHub LFS. Auth (if your server
          needs it) is handled by `.netrc` or git credential helpers,
          not by FrameCAD.
        </p>
        <label>LFS server URL</label>
        <input
          value={config.lfsUrl ?? ''}
          onChange={e => set('lfsUrl', e.target.value)}
          placeholder="https://lfs.your-server.com/team/robot.git/info/lfs"
        />
        <p className="admin-hint">
          Saving writes a <code>.lfsconfig</code> at the project root
          and pushes it, so teammates auto-pick the redirect on their
          next sync.
        </p>
      </div>

      <div className="admin-section">
        <h3>COTS Library</h3>
        <p className="admin-hint">
          Commercial Off-The-Shelf parts live in a separate Git repo and
          are cloned into a <code>COTS/</code> subfolder. The folder is
          gitignored so the two histories stay separate.
        </p>
        <label>COTS repo URL</label>
        <input
          value={config.cotsRepoUrl ?? ''}
          onChange={e => set('cotsRepoUrl', e.target.value)}
          placeholder="https://github.com/org/cots-library.git"
        />
        <label>COTS branch (optional)</label>
        <input
          value={config.cotsBranch ?? ''}
          onChange={e => set('cotsBranch', e.target.value)}
          placeholder="main"
        />
        <button
          className="toolbar-btn"
          onClick={handleSyncCots}
          disabled={!config.cotsRepoUrl || syncingCots}
        >
          {syncingCots ? 'Downloading...' : 'Download COTS now'}
        </button>
      </div>

      <div className="admin-section">
        <h3>Weekly Progress Tag</h3>
        <p className="admin-hint">
          Annotated Git tag at the current commit, pushed. Use to mark
          weekly snapshots so the team can browse the CAD state at any
          past milestone.
        </p>
        <label>Tag name</label>
        <div className="inline-input-row">
          <input
            value={tagName}
            onChange={e => setTagName(e.target.value)}
            placeholder="progress-2026-05-10"
          />
          <button
            className="toolbar-btn primary"
            onClick={handleCreateTag}
            disabled={!tagName.trim() || taggingNow}
          >
            {taggingNow ? 'Tagging...' : 'Tag now'}
          </button>
        </div>
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
