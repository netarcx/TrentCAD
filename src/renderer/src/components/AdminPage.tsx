import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type {
  AdminConfig, BulkMetaPatch, GlobalAdminConfig, GlobalAdminState, LockInfo,
  ManufacturingQueueItem, PartsManifest, PartMeta, ReleaseState, ManufacturingMethod
} from '@shared/types'
import ErrorMsg from './ErrorMsg'
import ProfileSetup from './ProfileSetup'
import PartsManager from './PartsManager'
import ApprovalsPanel from './ApprovalsPanel'
import MembersPanel from './settings/MembersPanel'

type AdminTab = 'settings' | 'members' | 'parts' | 'approvals' | 'documents' | 'locks' | 'health' | 'tools' | 'export-queue' | 'profile' | 'about'

interface JoinedPart {
  path: string
  partNumber: string
  type: string
  description?: string
  topLevel: string
  meta: PartMeta
}

function topLevelOf(path: string): string {
  const i = path.indexOf('/')
  return i === -1 ? '(root)' : path.slice(0, i)
}

interface Props {
  hasProject: boolean
  onClose: () => void
  appVersion: string
  gitName: string
  gitEmail: string
  onProfileUpdate: () => void
}

export default function AdminPage({ hasProject, onClose, appVersion, gitName, gitEmail, onProfileUpdate }: Props) {
  const [tab, setTab] = useState<AdminTab>('settings')

  // Per-project (only used in project mode)
  const [config, setConfig] = useState<AdminConfig>({})
  // Install-wide
  const [globalState, setGlobalState] = useState<GlobalAdminState | null>(null)
  const [globalForm, setGlobalForm] = useState<GlobalAdminConfig>({})

  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  // Per-project legacyMode flag, mirrored from parts.json. When true,
  // new files take their filename as the part number instead of the
  // YY-team-XX-YYY scheme. Toggling here saves + commits parts.json.
  const [legacyMode, setLegacyMode] = useState(false)
  const [legacyToggling, setLegacyToggling] = useState(false)
  const [syncingCots, setSyncingCots] = useState(false)
  const [taggingNow, setTaggingNow] = useState(false)
  const [tagName, setTagName] = useState(() => {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `progress-${yyyy}-${mm}-${dd}`
  })
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [generating, setGenerating] = useState<null | 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem'>(null)
  const [generated, setGenerated] = useState<Record<string, { filePath: string; relPath: string; pdfFilePath?: string } | undefined>>({})
  const [scanning, setScanning] = useState(false)
  const [largeFiles, setLargeFiles] = useState<Array<{
    path: string
    absolutePath: string
    size: number
    isLfsTracked: boolean
    status: 'blocker' | 'warning' | 'ok-lfs' | 'lfs-too-large'
  }> | null>(null)

  // Parts Manager
  const [partsLoading, setPartsLoading] = useState(false)
  const [allParts, setAllParts] = useState<JoinedPart[]>([])
  const [partsFilter, setPartsFilter] = useState('')
  const [partsSubsystem, setPartsSubsystem] = useState<string>('all')
  const [partsState, setPartsState] = useState<ReleaseState | 'all'>('all')
  // Edit queue: optimistic per-cell edits accumulate here and flush
  // through bulkUpdateMeta on a 1.2s idle debounce so rapid edits collapse
  // to one commit and the UI never blocks the user.
  const pendingRef = useRef<Map<string, BulkMetaPatch>>(new Map())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [flushing, setFlushing] = useState(false)

  // Locks (admin tab) — list of every active LFS lock with a force
  // release control. Used by mentors to recover files a teammate
  // forgot to check back in.
  const [locks, setLocks] = useState<LockInfo[] | null>(null)
  const [locksLoading, setLocksLoading] = useState(false)
  const [lockReleasing, setLockReleasing] = useState<string | null>(null)

  // Tools
  const [integrity, setIntegrity] = useState<null | {
    duplicates?: Array<{ partNumber: string; paths: string[] }>
    orphanedDrawings?: Array<{ path: string; linkedTo: string }>
    tombstones?: string[]
    orphanedMeta?: string[]
  }>(null)
  const [integrityRunning, setIntegrityRunning] = useState(false)
  const [renormRunning, setRenormRunning] = useState(false)

  useEffect(() => {
    let done = 0
    const finish = () => { done++; if (done === (hasProject ? 2 : 1)) setLoaded(true) }

    window.api.getGlobalAdmin()
      .then(state => {
        setGlobalState(state)
        setGlobalForm(state.effective)
      })
      .catch(() => {})
      .finally(finish)

    if (hasProject) {
      window.api.getAdminConfig()
        .then(c => setConfig(c || {}))
        .catch(() => setConfig({}))
        .finally(finish)
      // Pre-populate the main repo URL from the live git remote
      window.api.getMainRemoteUrl().then(url => {
        if (url) setConfig(prev => ({ ...prev, mainRepoUrl: prev.mainRepoUrl || url }))
      }).catch(() => {})
      // Mirror parts.json's legacyMode flag into the toggle so the
      // checkbox reflects current project state on open.
      window.api.getPartsManifest()
        .then(m => setLegacyMode(!!m?.legacyMode))
        .catch(() => {})
    }
  }, [hasProject])

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

  const set = <K extends keyof AdminConfig>(key: K, value: AdminConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const setGlobal = <K extends keyof GlobalAdminConfig>(key: K, value: GlobalAdminConfig[K]) => {
    setGlobalForm(prev => ({ ...prev, [key]: value }))
  }

  const handleSaveGlobal = async () => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await window.api.saveGlobalAdmin(globalForm)
      const fresh = await window.api.getGlobalAdmin()
      setGlobalState(fresh)
      setGlobalForm(fresh.effective)
      setStatus('Saved locally. This computer keeps these values across updates.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleResetGlobal = async () => {
    setError(null)
    setStatus(null)
    try {
      await window.api.resetGlobalAdmin()
      const fresh = await window.api.getGlobalAdmin()
      setGlobalState(fresh)
      setGlobalForm(fresh.effective)
      setStatus('Reset to team defaults shipped with this install.')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleSaveProject = async () => {
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

  const handleGenerate = async (type: 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem') => {
    setGenerating(type)
    setError(null)
    setStatus(null)
    try {
      const r = await window.api.generateDocument(type)
      if (r.success && r.filePath && r.relPath) {
        setGenerated(prev => ({
          ...prev,
          [type]: { filePath: r.filePath!, relPath: r.relPath!, pdfFilePath: r.pdfFilePath }
        }))
        const pdfNote = r.pdfFilePath
          ? ' (PDF written too)'
          : r.pdfError ? ` — PDF failed: ${r.pdfError}` : ''
        setStatus(`✓ Wrote ${r.relPath}${pdfNote}. Upload to share with the team.`)
      } else {
        setError(r.error || 'Could not generate document')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setGenerating(null)
    }
  }

  const handleOpenDoc = async (type: 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem') => {
    const doc = generated[type]
    if (!doc) return
    const r = await window.api.openPath(doc.filePath)
    if (!r.success) setError(r.error || 'Could not open file')
  }

  const handleOpenPdf = async (type: 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem') => {
    const doc = generated[type]
    if (!doc?.pdfFilePath) return
    const r = await window.api.openPath(doc.pdfFilePath)
    if (!r.success) setError(r.error || 'Could not open PDF')
  }

  const handleScanLarge = async () => {
    setScanning(true)
    setError(null)
    try {
      const r = await window.api.scanLargeFiles()
      if (r.success) setLargeFiles(r.files)
      else setError(r.error || 'Scan failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const handleReveal = async (absPath: string) => {
    const r = await window.api.revealInFolder(absPath)
    if (!r.success) setError(r.error || 'Could not open folder')
  }

  const formatSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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

  // Parts Manager: bulk-loads the manifest + all per-part meta and
  // joins them into one row per file so the table can render and edit
  // without N IPC calls.
  const loadAllParts = useCallback(async () => {
    if (!hasProject) return
    setPartsLoading(true)
    try {
      const [manifest, allMeta] = await Promise.all([
        window.api.getPartsManifest() as Promise<PartsManifest | null>,
        window.api.getAllPartsMeta() as Promise<Record<string, PartMeta>>
      ])
      if (!manifest) { setAllParts([]); return }
      const rows: JoinedPart[] = Object.entries(manifest.entries).map(([p, e]) => ({
        path: p,
        partNumber: e.partNumber,
        type: e.type,
        description: e.description,
        topLevel: topLevelOf(p),
        meta: allMeta[p] || {}
      }))
      rows.sort((a, b) => {
        if (a.topLevel !== b.topLevel) return a.topLevel.localeCompare(b.topLevel)
        return a.partNumber.localeCompare(b.partNumber)
      })
      setAllParts(rows)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPartsLoading(false)
    }
  }, [hasProject])

  // Auto-load when switching into Parts or Approvals tabs so the user
  // doesn't have to click a refresh button to see anything
  useEffect(() => {
    if ((tab === 'parts' || tab === 'approvals') && hasProject && allParts.length === 0 && !partsLoading) {
      loadAllParts()
    }
  }, [tab, hasProject, allParts.length, partsLoading, loadAllParts])

  // Refresh the parts cache whenever the main process broadcasts a
  // file-change. Meta writes go through broadcastStatus() in ipc.ts so
  // approvals/parts table picks up DetailsPanel / SW add-in edits
  // without the mentor having to click Refresh. Only fires for the
  // tabs that actually render the cached data.
  useEffect(() => {
    if (!hasProject) return
    if (tab !== 'parts' && tab !== 'approvals') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.onFileChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (pendingRef.current.size > 0 || flushing) return
        loadAllParts()
      }, 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      cleanup()
    }
  }, [tab, hasProject, loadAllParts])

  const flushNow = useCallback(async () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (pendingRef.current.size === 0) return
    const batch = Object.fromEntries(pendingRef.current)
    pendingRef.current = new Map()
    setPendingCount(0)
    setFlushing(true)
    setError(null)
    try {
      await window.api.bulkUpdateMeta(batch)
    } catch (err) {
      setError((err as Error).message)
      loadAllParts()
    } finally {
      setFlushing(false)
    }
  }, [loadAllParts])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      flushNow()
    }, 1200)
  }, [flushNow])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      if (pendingRef.current.size > 0) {
        const batch = Object.fromEntries(pendingRef.current)
        pendingRef.current = new Map()
        window.api.bulkUpdateMeta(batch).catch(() => {})
      }
    }
  }, [])

  const queueEdit = (rowPath: string, patch: BulkMetaPatch, optimisticPatch: Partial<PartMeta>) => {
    const existing = pendingRef.current.get(rowPath) || {}
    pendingRef.current.set(rowPath, { ...existing, ...patch })
    setPendingCount(pendingRef.current.size)
    setAllParts(prev => prev.map(r =>
      r.path === rowPath ? { ...r, meta: { ...r.meta, ...optimisticPatch } } : r
    ))
    scheduleFlush()
  }

  const handleSetReleaseState = (rowPath: string, state: ReleaseState) =>
    queueEdit(rowPath, { release: state }, { release: { state } })

  const handleSetMethod = (rowPath: string, method: ManufacturingMethod | null) =>
    queueEdit(rowPath, { manufacturingMethod: method }, { manufacturingMethod: method ?? undefined })

  const handleSetMaterial = (rowPath: string, material: string) =>
    queueEdit(rowPath, { manufacturingMaterial: material }, { manufacturingMaterial: material })

  const handleSetMass = async (rowPath: string, mass: number | null) => {
    setAllParts(prev => prev.map(r => r.path === rowPath ? { ...r, meta: { ...r.meta, mass: mass ?? undefined } } : r))
    try { await window.api.setPartMass(rowPath, mass) } catch (err) { setError((err as Error).message); loadAllParts() }
  }

  const handleSetCost = async (rowPath: string, cost: number | null) => {
    setAllParts(prev => prev.map(r => r.path === rowPath ? { ...r, meta: { ...r.meta, cost: cost ?? undefined } } : r))
    try { await window.api.setPartCost(rowPath, cost) } catch (err) { setError((err as Error).message); loadAllParts() }
  }

  const handleBulkApply = async (paths: string[], patch: BulkMetaPatch) => {
    if (paths.length === 0 || Object.keys(patch).length === 0) return
    const optimisticPatch: Partial<PartMeta> = {}
    if (patch.release !== undefined) optimisticPatch.release = { state: patch.release }
    if (patch.manufacturingMethod !== undefined) {
      optimisticPatch.manufacturingMethod = patch.manufacturingMethod ?? undefined
    }
    if (patch.manufacturingMaterial !== undefined) {
      optimisticPatch.manufacturingMaterial = (patch.manufacturingMaterial ?? '').trim() || undefined
    }
    for (const p of paths) {
      const existing = pendingRef.current.get(p) || {}
      pendingRef.current.set(p, { ...existing, ...patch })
    }
    setPendingCount(pendingRef.current.size)
    setAllParts(prev => prev.map(r =>
      paths.includes(r.path) ? { ...r, meta: { ...r.meta, ...optimisticPatch } } : r
    ))
    await flushNow()
  }

  // Tools
  const handleIntegrityCheck = async () => {
    setIntegrityRunning(true)
    setError(null)
    setStatus(null)
    try {
      const r = await window.api.checkManifestIntegrity()
      if (r.success) {
        setIntegrity({
          duplicates: r.duplicates,
          orphanedDrawings: r.orphanedDrawings,
          tombstones: r.tombstones,
          orphanedMeta: r.orphanedMeta
        })
      } else {
        setError(r.error || 'Integrity check failed')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIntegrityRunning(false)
    }
  }

  const loadLocks = useCallback(async () => {
    setLocksLoading(true)
    setError(null)
    try {
      const list = await window.api.getLocks()
      list.sort((a, b) => a.path.localeCompare(b.path))
      setLocks(list)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLocksLoading(false)
    }
  }, [])

  const handleForceRelease = async (lock: LockInfo) => {
    const ok = window.confirm(
      `Force-release ${lock.path}?\n\n` +
      `Currently checked out by ${lock.owner}. They will lose any unpublished ` +
      `edits to this file. Only do this if they're done or unreachable.`
    )
    if (!ok) return
    setLockReleasing(lock.path)
    setError(null)
    setStatus(null)
    try {
      await window.api.forceCheckIn(lock.path)
      setStatus(`✓ Released ${lock.path} (was held by ${lock.owner})`)
      await loadLocks()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLockReleasing(null)
    }
  }

  // Auto-load locks the first time the user switches into the Locks
  // tab so they don't have to click Refresh.
  useEffect(() => {
    if (tab === 'locks' && hasProject && locks === null && !locksLoading) {
      loadLocks()
    }
  }, [tab, hasProject, locks, locksLoading, loadLocks])

  const handleRenormalize = async () => {
    setRenormRunning(true)
    setError(null)
    setStatus(null)
    try {
      const r = await window.api.renormalizeAll()
      if (r.success) setStatus('✓ Re-applied .gitattributes filters to every tracked file. Next publish will pick up any changes.')
      else setError(r.error || 'Re-normalize failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRenormRunning(false)
    }
  }

  // Derived: parts filtered by search/subsystem/state
  const filteredParts = useMemo(() => {
    const q = partsFilter.trim().toLowerCase()
    return allParts.filter(p => {
      if (partsSubsystem !== 'all' && p.topLevel !== partsSubsystem) return false
      if (partsState !== 'all') {
        const s = p.meta.release?.state ?? 'draft'
        if (s !== partsState) return false
      }
      if (q) {
        const hay = `${p.partNumber} ${p.path} ${p.description ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [allParts, partsFilter, partsSubsystem, partsState])

  const subsystemOptions = useMemo(() => {
    const set = new Set<string>()
    allParts.forEach(p => set.add(p.topLevel))
    return Array.from(set).sort()
  }, [allParts])

  const inReviewParts = useMemo(() =>
    allParts.filter(p => (p.meta.release?.state ?? 'draft') === 'in-review'),
  [allParts])

  // ESC to close the full-screen page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Hidden 9-click sequence in the bottom-right corner. Once triggered,
  // the welcome screen permanently shows an Admin Panel button. Reset
  // the counter if the user pauses for more than 3s between clicks so
  // accidental drags don't half-fill it.
  // NB: must be declared before any conditional return (e.g. !loaded)
  // or React will complain that hook order changed between renders.
  const [cornerClicks, setCornerClicks] = useState(0)
  const [shortcutToast, setShortcutToast] = useState<string | null>(null)
  useEffect(() => {
    if (cornerClicks === 0) return
    if (cornerClicks >= 9) {
      localStorage.setItem('framecad-admin-shortcut-unlocked', '1')
      // Notify any listening welcome-screen instance in the same window
      // (storage events only fire across windows, not within one).
      window.dispatchEvent(new CustomEvent('admin-shortcut-unlocked'))
      setShortcutToast('Admin shortcut unlocked — look for the button on the welcome screen.')
      setCornerClicks(0)
      const t = setTimeout(() => setShortcutToast(null), 4000)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setCornerClicks(0), 3000)
    return () => clearTimeout(t)
  }, [cornerClicks])

  if (!loaded) return null

  const overrideStatusLine = globalState && globalState.hasLocalOverride
    ? 'Showing your local overrides. These survive app updates until you Reset.'
    : 'Showing team defaults shipped with this install.'

  const tabs: { id: AdminTab; label: string; projectOnly?: boolean }[] = [
    { id: 'settings', label: 'Settings' },
    { id: 'members', label: 'Members' },
    { id: 'parts', label: 'Parts Manager', projectOnly: true },
    { id: 'approvals', label: 'Approvals', projectOnly: true },
    { id: 'documents', label: 'Documents', projectOnly: true },
    { id: 'locks', label: 'Locks', projectOnly: true },
    { id: 'health', label: 'Repository Health', projectOnly: true },
    { id: 'tools', label: 'Tools', projectOnly: true },
    { id: 'export-queue', label: 'Export Queue', projectOnly: true },
    { id: 'profile', label: 'Profile' },
    { id: 'about', label: 'About' }
  ]
  const visibleTabs = tabs.filter(t => !t.projectOnly || hasProject)

  return (
    <div className="admin-fullscreen">
      <div className="admin-topbar">
        <div className="admin-topbar-title">Admin {hasProject ? '' : '· Welcome screen'}</div>
        <div className="admin-topbar-actions">
          <button className="toolbar-btn" onClick={onClose}>Close (Esc)</button>
        </div>
      </div>
      {shortcutToast && <div className="admin-shortcut-toast">{shortcutToast}</div>}
      <div
        className="admin-corner-tap"
        onClick={() => setCornerClicks(c => c + 1)}
        aria-hidden="true"
      />
      <div className="admin-layout">
        <nav className="admin-sidebar">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              className={`admin-sidebar-item${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="admin-content">

        {tab === 'parts' && hasProject && (
          <PartsManager
            loading={partsLoading}
            parts={filteredParts}
            allParts={allParts}
            filter={partsFilter}
            setFilter={setPartsFilter}
            subsystem={partsSubsystem}
            setSubsystem={setPartsSubsystem}
            subsystemOptions={subsystemOptions}
            state={partsState}
            setState={setPartsState}
            pendingCount={pendingCount}
            flushing={flushing}
            flushNow={flushNow}
            onRefresh={loadAllParts}
            onSetRelease={handleSetReleaseState}
            onSetMethod={handleSetMethod}
            onSetMaterial={handleSetMaterial}
            onSetMass={handleSetMass}
            onSetCost={handleSetCost}
            onBulkApply={handleBulkApply}
          />
        )}

        {tab === 'approvals' && hasProject && (
          <ApprovalsPanel
            parts={inReviewParts}
            onApprove={(p) => handleSetReleaseState(p, 'released')}
            onReject={(p) => handleSetReleaseState(p, 'draft')}
            onRefresh={loadAllParts}
          />
        )}

        {tab === 'tools' && hasProject && (
          <ToolsTab
            integrity={integrity}
            integrityRunning={integrityRunning}
            onIntegrityCheck={handleIntegrityCheck}
            renormRunning={renormRunning}
            onRenormalize={handleRenormalize}
          />
        )}

        {tab === 'members' && (
          <MembersPanel />
        )}

        {tab === 'settings' && (
          <>
            <p className="admin-warning">
              Team and GitHub Browse settings are saved on this computer only.
              {' '}{overrideStatusLine}
            </p>

            <div className="admin-section">
              <h3>Team</h3>
              <label>Team name</label>
              <input
                value={globalForm.teamName ?? ''}
                onChange={e => setGlobal('teamName', e.target.value)}
                placeholder={globalState?.defaults.teamName || 'FRC Team 2129'}
              />
              <label>Welcome message</label>
              <textarea
                value={globalForm.welcomeMessage ?? ''}
                onChange={e => setGlobal('welcomeMessage', e.target.value)}
                placeholder={globalState?.defaults.welcomeMessage || 'Optional message shown to teammates'}
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
                value={globalForm.gitHubOrg ?? ''}
                onChange={e => setGlobal('gitHubOrg', e.target.value)}
                placeholder={globalState?.defaults.gitHubOrg || 'netarcx'}
              />
              <label>Project name prefix</label>
              <input
                value={globalForm.projectPrefix ?? ''}
                onChange={e => setGlobal('projectPrefix', e.target.value)}
                placeholder={globalState?.defaults.projectPrefix || 'framecad-'}
              />
            </div>

            <div className="admin-section-actions">
              <button
                className="toolbar-btn"
                onClick={handleResetGlobal}
                disabled={saving || !globalState?.hasLocalOverride}
                title={globalState?.hasLocalOverride
                  ? 'Discard local overrides and use the team defaults shipped with this install'
                  : 'No local overrides to reset'}
              >
                Reset to team defaults
              </button>
              <button className="toolbar-btn primary" onClick={handleSaveGlobal} disabled={saving}>
                {saving ? 'Saving…' : 'Save (local)'}
              </button>
            </div>

            {hasProject && (
              <>
                <hr className="admin-divider" />

                <p className="admin-warning">
                  The settings below are committed and pushed to <em>this project's</em>
                  {' '}git repo on Save. Every teammate picks them up on their next Download.
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
                  <p className="admin-hint">
                    Turn this on for an existing project that pre-dates
                    FrameCAD's numbering scheme. New files keep their
                    original filename (e.g. <code>Frame.sldprt</code>) as
                    the displayed part number instead of getting a
                    generated <code>26-2129-001</code>. <strong>Toggling
                    doesn't rewrite existing part numbers</strong> — SolidWorks
                    assembly references would break if it did, so once a
                    file has a number it keeps that number for life. Only
                    files added after the flip pick up the other behavior.
                    FrameCAD auto-enables this when opening a non-FrameCAD
                    project for the first time.
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
                    (rudolfs, giftless, Gitea, GitLab, etc.) — git push/pull
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
                  <button className="toolbar-btn primary" onClick={handleSaveProject} disabled={saving}>
                    {saving ? 'Saving...' : 'Save project settings & Upload'}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'documents' && hasProject && (
          <div className="admin-section">
            <h3>Build & Manufacturing Documents</h3>
            <p className="admin-hint">
              Generate up-to-date documents from this project's part data —
              Bill of Materials, manufacturing cut list, project summary, and
              per-subsystem BOMs. Files write to a <code>Documents/</code>
              folder in the project root and ride along on your next publish.
            </p>
            <div className="doc-grid">
              {(['bom', 'manufacturing', 'summary', 'bom-by-subsystem'] as const).map(t => {
                const meta = ({
                  bom: {
                    title: 'Bill of Materials',
                    sub: 'Every released and in-progress part — one combined sheet',
                  },
                  manufacturing: {
                    title: 'Manufacturing Queue',
                    sub: 'Released + in-review parts grouped by method / material',
                  },
                  summary: {
                    title: 'Project Summary',
                    sub: 'Mass + cost rollup by subsystem and by shop method',
                  },
                  'bom-by-subsystem': {
                    title: 'BOMs by Subsystem',
                    sub: 'One BOM per top-level folder (Drivetrain, Intake, etc.)',
                  }
                } as const)[t]
                const doc = generated[t]
                return (
                  <div key={t} className="doc-card">
                    <div className="doc-card-title">{meta.title}</div>
                    <div className="doc-card-sub">{meta.sub}</div>
                    <div className="doc-card-actions">
                      <button
                        className="toolbar-btn primary"
                        disabled={generating !== null}
                        onClick={() => handleGenerate(t)}
                      >
                        {generating === t ? 'Generating…' : doc ? 'Regenerate' : 'Generate'}
                      </button>
                      {doc && (
                        <button
                          className="toolbar-btn"
                          onClick={() => handleOpenDoc(t)}
                          title={doc.filePath}
                        >
                          Open source
                        </button>
                      )}
                      {doc?.pdfFilePath && (
                        <button
                          className="toolbar-btn"
                          onClick={() => handleOpenPdf(t)}
                          title={doc.pdfFilePath}
                        >
                          Open PDF
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'locks' && hasProject && (
          <div className="admin-section">
            <h3>Active Check-outs</h3>
            <p className="admin-hint">
              Every file currently checked out (LFS-locked) on the team's repo.
              Use <strong>Force release</strong> to undo someone else's check-out
              when they've forgotten to check it back in — they will lose any
              unpublished edits to that file, so use sparingly and only after
              confirming with them when possible.
            </p>
            <div className="admin-section-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="toolbar-btn" onClick={loadLocks} disabled={locksLoading}>
                {locksLoading ? 'Loading…' : 'Refresh'}
              </button>
              <span className="parts-count">
                {locks === null ? '' : `${locks.length} active`}
              </span>
            </div>
            {locks && locks.length === 0 && (
              <div className="admin-status">✓ Nobody has anything checked out right now.</div>
            )}
            {locks && locks.length > 0 && (
              <div className="approvals-list">
                {locks.map(l => (
                  <div key={l.id || l.path} className="approval-row">
                    <div className="approval-main">
                      <div className="approval-pn">{l.owner}</div>
                      <div className="approval-meta">
                        <strong>{l.path}</strong>
                      </div>
                    </div>
                    <div className="approval-actions">
                      <button
                        className="toolbar-btn"
                        onClick={() => handleForceRelease(l)}
                        disabled={lockReleasing === l.path}
                      >
                        {lockReleasing === l.path ? 'Releasing…' : 'Force release'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'health' && hasProject && (
          <div className="admin-section">
            <h3>Repository Health — Large Files</h3>
            <p className="admin-hint">
              Scans the project for files over 50 MB and shows which would
              trip GitHub's pre-receive hook on publish. Blockers (red) need
              to be deleted, moved out of the repo, or added to LFS before
              the next push will succeed.
            </p>
            <div className="admin-section-actions" style={{ justifyContent: 'flex-start' }}>
              <button
                className="toolbar-btn primary"
                onClick={handleScanLarge}
                disabled={scanning}
              >
                {scanning ? 'Scanning…' : largeFiles ? 'Re-scan' : 'Scan for large files'}
              </button>
            </div>
            {largeFiles !== null && largeFiles.length === 0 && (
              <div className="admin-status">✓ No files over 50 MB found. You're good to push.</div>
            )}
            {largeFiles !== null && largeFiles.length > 0 && (
              <div className="large-files-list">
                {largeFiles.map(f => (
                  <div key={f.path} className={`large-file-row large-file-${f.status}`}>
                    <div className="large-file-meta">
                      <span className={`large-file-badge large-file-badge-${f.status}`}>
                        {f.status === 'blocker' && 'BLOCKER'}
                        {f.status === 'warning' && 'WARNING'}
                        {f.status === 'ok-lfs' && 'OK (LFS)'}
                        {f.status === 'lfs-too-large' && 'LFS OVER 5 GB'}
                      </span>
                      <span className="large-file-size">{formatSize(f.size)}</span>
                    </div>
                    <div className="large-file-path" title={f.absolutePath}>{f.path}</div>
                    <div className="large-file-hint">
                      {f.status === 'blocker' && 'GitHub rejects non-LFS files over 100 MB. Delete this, move it out of the repo, or add its extension to .gitattributes and re-stage.'}
                      {f.status === 'warning' && 'Over GitHub\'s 50 MB recommendation. Will succeed but could grow into a blocker.'}
                      {f.status === 'ok-lfs' && 'Tracked by Git LFS — fine at any size up to 5 GB.'}
                      {f.status === 'lfs-too-large' && 'LFS objects max out at 5 GB. Split this file before publishing.'}
                    </div>
                    <div className="large-file-actions">
                      <button className="toolbar-btn" onClick={() => handleReveal(f.absolutePath)}>
                        Show in folder
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'export-queue' && hasProject && (
          <ExportQueueTab />
        )}

        {tab === 'profile' && (
          <div className="settings-profile-wrap">
            <ProfileSetup
              onComplete={onProfileUpdate}
              initialName={gitName}
              initialEmail={gitEmail}
              embedded
            />
          </div>
        )}

        {tab === 'about' && (
          <div className="admin-section">
            <h3>About FrameCAD</h3>
            <p>Version {appVersion || 'unknown'}</p>
            <p className="admin-hint">
              Press Ctrl+Shift+R to check for updates manually.
            </p>
          </div>
        )}

        {error && <ErrorMsg text={error} />}
        {status && <div className="admin-status">{status}</div>}

        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Sub-components for the new tabs. Kept in the same file to avoid
// component-file sprawl; they read state passed down from AdminPage.
// ---------------------------------------------------------------------

interface ToolsTabProps {
  integrity: null | {
    duplicates?: Array<{ partNumber: string; paths: string[] }>
    orphanedDrawings?: Array<{ path: string; linkedTo: string }>
    tombstones?: string[]
    orphanedMeta?: string[]
  }
  integrityRunning: boolean
  onIntegrityCheck: () => void
  renormRunning: boolean
  onRenormalize: () => void
}

function ToolsTab(props: ToolsTabProps) {
  const { integrity, integrityRunning, onIntegrityCheck, renormRunning, onRenormalize } = props
  return (
    <>
      <div className="admin-section">
        <h3>Manifest Integrity Check</h3>
        <p className="admin-hint">
          Scans parts.json for problems mentors should know about:
          duplicate part numbers (rare but breaks the BOM), drawings
          whose linked part no longer exists, and tombstone entries
          (parts.json knows about them but the file's gone from disk).
        </p>
        <div className="admin-section-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="toolbar-btn primary" onClick={onIntegrityCheck} disabled={integrityRunning}>
            {integrityRunning ? 'Scanning…' : integrity ? 'Re-scan' : 'Run integrity check'}
          </button>
        </div>
        {integrity && (
          <div className="integrity-results">
            {(!integrity.duplicates || integrity.duplicates.length === 0) &&
             (!integrity.orphanedDrawings || integrity.orphanedDrawings.length === 0) &&
             (!integrity.tombstones || integrity.tombstones.length === 0) &&
             (!integrity.orphanedMeta || integrity.orphanedMeta.length === 0) && (
              <div className="admin-status">✓ No integrity problems found.</div>
            )}
            {integrity.duplicates && integrity.duplicates.length > 0 && (
              <div className="integrity-block">
                <h4>Duplicate part numbers ({integrity.duplicates.length})</h4>
                {integrity.duplicates.map(d => (
                  <div key={d.partNumber} className="integrity-row">
                    <strong>{d.partNumber}</strong>
                    <ul>{d.paths.map(p => <li key={p}>{p}</li>)}</ul>
                  </div>
                ))}
              </div>
            )}
            {integrity.orphanedDrawings && integrity.orphanedDrawings.length > 0 && (
              <div className="integrity-block">
                <h4>Orphaned drawings ({integrity.orphanedDrawings.length})</h4>
                {integrity.orphanedDrawings.map(o => (
                  <div key={o.path} className="integrity-row">
                    <div><strong>{o.path}</strong></div>
                    <div className="admin-hint" style={{ marginTop: 2 }}>links to missing part: {o.linkedTo}</div>
                  </div>
                ))}
              </div>
            )}
            {integrity.tombstones && integrity.tombstones.length > 0 && (
              <div className="integrity-block">
                <h4>Tombstones ({integrity.tombstones.length})</h4>
                <p className="admin-hint">
                  These are intentional — tombstones prevent part-number reuse.
                  Only worry if you actually deleted a file you didn't mean to.
                </p>
                <ul>{integrity.tombstones.map(t => <li key={t}>{t}</li>)}</ul>
              </div>
            )}
            {integrity.orphanedMeta && integrity.orphanedMeta.length > 0 && (
              <div className="integrity-block">
                <h4>Orphaned metadata ({integrity.orphanedMeta.length})</h4>
                <p className="admin-hint">
                  parts-meta.json has entries for paths that don't exist in
                  parts.json. Usually leftover from a rename or delete that
                  happened before v0.8.5 — new renames migrate cleanly.
                  Safe to leave; can be removed by hand if it bothers you.
                </p>
                <ul>{integrity.orphanedMeta.map(m => <li key={m}>{m}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Re-apply LFS Filters</h3>
        <p className="admin-hint">
          Runs <code>git add --renormalize -A</code> across the project.
          Use this if you suspect a file got committed as a raw blob
          before its extension was added to LFS — re-staging through
          the current <code>.gitattributes</code> fixes the index.
          Publish already does this automatically, but a manual button
          helps when diagnosing a stuck push.
        </p>
        <div className="admin-section-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="toolbar-btn primary" onClick={onRenormalize} disabled={renormRunning}>
            {renormRunning ? 'Re-normalizing…' : 'Re-normalize all files'}
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------
// Export Queue tab — released parts that still need a paired .step/.stl
// pushed by the SolidWorks add-in. Batch-trigger lives here so a backlog
// can be cleared in one click once SW is open.
// ---------------------------------------------------------------------

function relTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString()
}

function ExportQueueTab() {
  const [items, setItems] = useState<ManufacturingQueueItem[]>([])
  const [swAlive, setSwAlive] = useState(false)
  const [pendingTasks, setPendingTasks] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [perRowBusy, setPerRowBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await window.api.getExportStatus()
      setItems(s.needsExport)
      setSwAlive(s.swAlive)
      setPendingTasks(s.pendingTasks)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Re-poll every 4s while the tab is mounted so swAlive and the
  // pending-task count reflect the SolidWorks add-in's actual state
  // (it heartbeats every 5s via /api/health).
  useEffect(() => {
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  // Pick up new "needs export" entries as parts get released elsewhere.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.onFileChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 250)
    })
    return () => { if (timer) clearTimeout(timer); cleanup() }
  }, [refresh])

  const onBatch = async () => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const r = await window.api.triggerBatchExport()
      setStatus(r.queued === 0
        ? 'Nothing to export — all released CAM parts already have their files.'
        : `Queued ${r.queued} export${r.queued === 1 ? '' : 's'}. SolidWorks will work through them.`)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onOne = async (filePath: string) => {
    setPerRowBusy(filePath)
    setError(null)
    setStatus(null)
    try {
      const r = await window.api.triggerPartExport(filePath)
      setStatus(r.alreadyExists
        ? 'File already on disk — nothing to do.'
        : 'Queued. SolidWorks will pick it up shortly.')
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPerRowBusy(null)
    }
  }

  return (
    <div className="admin-section">
      <h3>Export Queue</h3>
      <p className="admin-hint">
        Released parts with method <strong>CNC</strong> or <strong>3D Print</strong> need a paired CAM file
        (<code>.step</code> or <code>.stl</code>) alongside the source. Parts missing that file appear here.
        When SolidWorks is open with the FrameCAD add-in, hitting <em>Batch Export</em> queues SaveAs operations
        for every missing file in one shot.
      </p>

      <div className="export-queue-status">
        <div className={`export-queue-sw-state${swAlive ? ' alive' : ''}`}>
          <span className="export-queue-dot" />
          {swAlive ? 'SolidWorks add-in connected' : 'SolidWorks add-in not connected'}
        </div>
        {pendingTasks > 0 && (
          <div className="export-queue-pending">
            {pendingTasks} export task{pendingTasks === 1 ? '' : 's'} in flight
          </div>
        )}
        <div className="export-queue-actions">
          <button className="toolbar-btn" onClick={refresh} disabled={loading}>Refresh</button>
          <button
            className="toolbar-btn primary"
            onClick={onBatch}
            disabled={busy || !swAlive || items.length === 0}
            title={!swAlive ? 'Open SolidWorks with the FrameCAD add-in first' : undefined}
          >
            {busy ? 'Queueing…' : `Batch Export ${items.length || ''}`.trim()}
          </button>
        </div>
      </div>

      {error && <ErrorMsg text={error} />}
      {status && <div className="admin-status">{status}</div>}

      {loading && items.length === 0 && <div className="mfg-queue-empty">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="mfg-queue-empty">All released CAM parts have their export files. Nothing to do.</div>
      )}

      {items.length > 0 && (
        <div className="mfg-queue-list">
          {items.map(item => (
            <div className="mfg-queue-item needs-export" key={item.path}>
              <div className="mfg-queue-main">
                <div className="mfg-queue-path">
                  {item.path}
                  <span className="mfg-queue-needs-export-badge">
                    Needs .{item.needsExport}
                  </span>
                </div>
                <div className="mfg-queue-meta">
                  <span><strong>Method:</strong> {item.method === 'cnc' ? 'CNC' : item.method === 'print' ? '3D Print' : item.method}</span>
                  {item.material && <span><strong>Material:</strong> {item.material}</span>}
                  {item.releasedBy && <span><strong>Released by:</strong> {item.releasedBy}</span>}
                  {item.releasedAt && <span>{relTime(item.releasedAt)}</span>}
                </div>
                {item.expectedExportPath && (
                  <div className="mfg-queue-notes">Expected at: <code>{item.expectedExportPath}</code></div>
                )}
              </div>
              <button
                className="toolbar-btn"
                onClick={() => onOne(item.path)}
                disabled={perRowBusy === item.path || !swAlive}
                title={!swAlive ? 'Open SolidWorks with the FrameCAD add-in first' : undefined}
              >
                {perRowBusy === item.path ? '…' : 'Export Now'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
