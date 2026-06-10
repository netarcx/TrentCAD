import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Printer, Cog, Hammer, ShoppingCart, Package, RefreshCw,
  AlertTriangle, Inbox, Box, User, MapPin, type LucideIcon
} from 'lucide-react'
import type { ManufacturingMethod, ManufacturingQueueItem } from '@shared/types'
import FileThumbnail from './FileThumbnail'
import ErrorMsg from './ErrorMsg'

const METHODS: { key: ManufacturingMethod; label: string; Icon: LucideIcon }[] = [
  { key: 'print', label: '3D Print', Icon: Printer },
  { key: 'cnc', label: 'CNC', Icon: Cog },
  { key: 'manual', label: 'Hand', Icon: Hammer },
  { key: 'purchase', label: 'Purchase', Icon: ShoppingCart },
  { key: 'other', label: 'Other', Icon: Package }
]

function methodLabel(m: ManufacturingMethod): string {
  return METHODS.find(x => x.key === m)?.label ?? m
}

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}

/** "Drivetrain/26-2129-01-005.sldprt" → "26-2129-01-005" */
function fileTitle(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.(sldprt|sldasm|slddrw)$/i, '')
}

/** "Drivetrain/26-2129-01-005.sldprt" → "Drivetrain" ('' at project root) */
function folderOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : ''
}

// Persisted across sessions so a single operator working through a
// long queue doesn't keep re-typing — but kept prominently visible so
// the next person at the kiosk can spot and change it before pressing
// Done. localStorage key is intentionally distinct from any other config
// (these are shop-floor initials, not the team identity).
const OPERATOR_KEY = 'framecad-mfg-operator-initials'
const LOCATION_KEY = 'framecad-mfg-location'

function normalizeInitials(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9.]/g, '').slice(0, 6).toUpperCase()
}

export default function ManufacturingQueue() {
  const [items, setItems] = useState<ManufacturingQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ManufacturingMethod>('print')
  const [markingDone, setMarkingDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [operator, setOperator] = useState<string>(() =>
    normalizeInitials(localStorage.getItem(OPERATOR_KEY) || '')
  )
  // Where finished parts are being put right now (e.g. "Shelf B3"). Persisted
  // like the operator initials so a station doesn't re-type it each part.
  const [location, setLocation] = useState<string>(() => localStorage.getItem(LOCATION_KEY) || '')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.getManufacturingQueue()
      setItems(list)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Listen for cross-window meta changes (DetailsPanel, SW add-in,
  // Admin) so the shop-floor queue reflects new releases / methods
  // without anyone having to click Refresh. ipc.ts broadcasts a
  // file-change after every meta-mutating IPC handler.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.onFileChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { refresh() }, 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      cleanup()
    }
  }, [refresh])

  // Per-method tallies in a single pass over `items`, memoized so typing
  // in the operator / location inputs doesn't re-walk the whole queue
  // each keystroke. `visible` stays its own memo since it also depends
  // on `tab`.
  const { counts, needsExportCounts, totalNeedsExport, totalQueued } = useMemo(() => {
    const counts: Record<string, number> = {}
    const needsExportCounts: Record<string, number> = {}
    let totalNeedsExport = 0
    let totalQueued = 0
    for (const m of METHODS) {
      counts[m.key] = 0
      needsExportCounts[m.key] = 0
    }
    for (const i of items) {
      if (i.method in counts) {
        counts[i.method]++
        totalQueued++
        if (i.needsExport) needsExportCounts[i.method]++
      }
      if (i.needsExport) totalNeedsExport++
    }
    return { counts, needsExportCounts, totalNeedsExport, totalQueued }
  }, [items])

  const visible = useMemo(() => items.filter(i => i.method === tab), [items, tab])

  const handleMarkManufactured = async (path: string) => {
    const initials = normalizeInitials(operator)
    if (!initials) {
      setError('Enter your initials at the top of the queue before marking parts done.')
      return
    }
    // Persist the latest value — if they changed it inline right
    // before pressing Done, we want next session to remember the
    // updated value, not the stale one from page load.
    localStorage.setItem(OPERATOR_KEY, initials)
    const loc = location.trim()
    if (loc) localStorage.setItem(LOCATION_KEY, loc)
    else localStorage.removeItem(LOCATION_KEY)
    setMarkingDone(path)
    setError(null)
    try {
      // A purchased part is "received" rather than "manufactured" — advance the
      // purchase axis too so it doesn't drift (and so it reads correctly in the
      // part details), then move the release state so it leaves the queue.
      if (tab === 'purchase') {
        await window.api.setPurchaseInfo(path, { status: 'received' })
      }
      await window.api.setReleaseState(path, 'manufactured', `${tab === 'purchase' ? 'Received' : 'Finished'} by ${initials}`, loc || undefined)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setMarkingDone(null)
    }
  }

  const operatorReady = normalizeInitials(operator).length > 0
  const doneLabel = tab === 'purchase' ? 'Mark received' : 'Mark done'

  return (
    <div className="mfg-queue-embedded">
      <div className="mfg-shop-header">
        <div className="mfg-shop-heading">
          <h2>Manufacturing Queue</h2>
          <span className="mfg-shop-sub">
            {totalQueued === 0
              ? 'Nothing waiting — released parts land here, grouped by how they get made.'
              : `${totalQueued} released ${totalQueued === 1 ? 'part' : 'parts'} waiting to be made. Press ${tab === 'purchase' ? 'Mark received' : 'Mark done'} when a part is finished.`}
          </span>
        </div>
        <button className="toolbar-btn mfg-shop-refresh" onClick={refresh} disabled={loading} title="Re-read the queue from the project">
          <RefreshCw size={14} className={loading ? 'mfg-spin' : undefined} />
          Refresh
        </button>
      </div>

      <div className="mfg-station-bar">
        <div className="mfg-station-field">
          <label htmlFor="mfg-operator-input"><User size={13} /> Operator initials</label>
          <input
            id="mfg-operator-input"
            type="text"
            value={operator}
            onChange={e => setOperator(normalizeInitials(e.target.value))}
            onBlur={() => {
              const v = normalizeInitials(operator)
              setOperator(v)
              if (v) localStorage.setItem(OPERATOR_KEY, v)
            }}
            placeholder="e.g. JD"
            maxLength={6}
            autoComplete="off"
          />
        </div>
        <div className="mfg-station-field">
          <label htmlFor="mfg-location-input"><MapPin size={13} /> Storing finished parts at</label>
          <input
            id="mfg-location-input"
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            onBlur={() => {
              const v = location.trim()
              if (v) localStorage.setItem(LOCATION_KEY, v)
              else localStorage.removeItem(LOCATION_KEY)
            }}
            placeholder="e.g. Shelf B3 (optional)"
            maxLength={60}
            autoComplete="off"
            className="mfg-location-input"
          />
        </div>
        <span className="mfg-station-hint">
          Initials are required to mark parts done — the next person at this station can change them before pressing the button.
        </span>
      </div>

      {totalNeedsExport > 0 && (
        <div className="mfg-queue-export-banner">
          <AlertTriangle size={14} />
          <span>
            <strong>{totalNeedsExport}</strong> {totalNeedsExport === 1 ? 'part is' : 'parts are'} released but missing the paired CAM file. Use <em>Admin → Export Queue</em> to batch-export, or open the part in SolidWorks to trigger an auto-export.
          </span>
        </div>
      )}

      <div className="mfg-shop-tabs">
        {METHODS.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`mfg-shop-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            <Icon size={15} />
            {label}
            <span className="mfg-queue-count">{counts[key] || 0}</span>
            {(needsExportCounts[key] || 0) > 0 && (
              <span className="mfg-queue-needs-export-pill" title="Parts missing their CAM export">
                {needsExportCounts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && items.length === 0 && (
        <div className="mfg-shop-empty"><RefreshCw size={32} className="mfg-spin" /><p>Loading the queue…</p></div>
      )}
      {!loading && visible.length === 0 && (
        <div className="mfg-shop-empty">
          <Inbox size={32} />
          <p>No parts queued for {methodLabel(tab)}.</p>
          <span>Parts appear here when a mentor releases them with the {methodLabel(tab)} method.</span>
        </div>
      )}

      {visible.length > 0 && (
        <div className="mfg-card-grid">
          {visible.map(item => {
            const title = fileTitle(item.path)
            const folder = folderOf(item.path)
            return (
              <div className={`mfg-card${item.needsExport ? ' needs-export' : ''}`} key={item.path}>
                <div className="mfg-card-top">
                  <FileThumbnail
                    path={item.path}
                    size={72}
                    className="mfg-card-thumb"
                    title={item.path}
                    fallback={<div className="mfg-card-thumb mfg-card-thumb-fallback"><Box size={28} /></div>}
                  />
                  <div className="mfg-card-id">
                    <div className="mfg-card-name" title={item.path}>{title}</div>
                    <div className="mfg-card-folder">{folder || 'Project root'}</div>
                  </div>
                </div>
                <div className="mfg-card-chips">
                  {item.material && <span className="mfg-chip mfg-chip-material">{item.material}</span>}
                  {typeof item.mass === 'number' && <span className="mfg-chip">{item.mass.toFixed(2)} lb</span>}
                  {item.releasedBy && <span className="mfg-chip">Released by {item.releasedBy}</span>}
                  {item.releasedAt && <span className="mfg-chip mfg-chip-time">{relativeTime(item.releasedAt)}</span>}
                </div>
                {item.notes && <div className="mfg-card-notes">{item.notes}</div>}
                {item.needsExport && (
                  <div className="mfg-card-export-warn" title={item.expectedExportPath ? `Expected file: ${item.expectedExportPath}` : undefined}>
                    <AlertTriangle size={13} />
                    Missing the .{item.needsExport} export — open this part in SolidWorks to generate it.
                  </div>
                )}
                <button
                  className="mfg-card-done"
                  onClick={() => handleMarkManufactured(item.path)}
                  disabled={markingDone === item.path || !operatorReady}
                  title={!operatorReady ? 'Enter your initials at the top first' : undefined}
                >
                  {markingDone === item.path ? 'Saving…' : doneLabel}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {error && <ErrorMsg text={error} />}
    </div>
  )
}
