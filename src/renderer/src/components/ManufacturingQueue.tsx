import { useEffect, useState, useCallback } from 'react'
import type { ManufacturingMethod, ManufacturingQueueItem } from '@shared/types'
import ErrorMsg from './ErrorMsg'

interface Props {
  onClose: () => void
  /**
   * When `embedded`, renders without the modal-overlay wrapper so the
   * queue can live inside a dedicated full-screen view (Manufacturing
   * View on the welcome screen). The Close button still calls onClose
   * so the parent can exit the view.
   */
  embedded?: boolean
}

const METHODS: ManufacturingMethod[] = ['print', 'cnc', 'manual', 'purchase', 'other']

function methodLabel(m: ManufacturingMethod): string {
  switch (m) {
    case 'print': return '3D Print'
    case 'cnc': return 'CNC'
    case 'manual': return 'Hand'
    case 'purchase': return 'Purchase'
    case 'other': return 'Other'
  }
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

// Persisted across sessions so a single operator working through a
// long queue doesn't keep re-typing — but kept prominently visible so
// the next person at the kiosk can spot and change it before pressing
// Done. localStorage key is intentionally distinct from any git config
// (these are shop-floor initials, not the GitHub identity).
const OPERATOR_KEY = 'framecad-mfg-operator-initials'
const LOCATION_KEY = 'framecad-mfg-location'

function normalizeInitials(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9.]/g, '').slice(0, 6).toUpperCase()
}

export default function ManufacturingQueue({ onClose, embedded = false }: Props) {
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

  const counts = METHODS.reduce<Record<string, number>>((acc, m) => {
    acc[m] = items.filter(i => i.method === m).length
    return acc
  }, {})

  const needsExportCounts = METHODS.reduce<Record<string, number>>((acc, m) => {
    acc[m] = items.filter(i => i.method === m && !!i.needsExport).length
    return acc
  }, {})

  const totalNeedsExport = items.filter(i => !!i.needsExport).length

  const visible = items.filter(i => i.method === tab)

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

  const body = (
    <>
        <h2>Manufacturing Queue</h2>
        <p className="admin-hint">
          Every part with release state <strong>Released</strong> appears here, grouped by manufacturing method. Click <em>Done</em> when the part has been made and state will move to <strong>Manufactured</strong>.
        </p>

        <div className="mfg-operator-bar">
          <label htmlFor="mfg-operator-input">Operator initials</label>
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
          <span className="mfg-operator-hint">
            Required to mark parts done — the next person can edit this before pressing Done.
          </span>
          <label htmlFor="mfg-location-input" style={{ marginLeft: 16 }}>Storing at (optional)</label>
          <input
            id="mfg-location-input"
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            onBlur={() => { const v = location.trim(); if (v) localStorage.setItem(LOCATION_KEY, v) }}
            placeholder="e.g. Shelf B3"
            maxLength={60}
            autoComplete="off"
          />
        </div>

        {totalNeedsExport > 0 && (
          <div className="mfg-queue-export-banner">
            <strong>{totalNeedsExport}</strong> {totalNeedsExport === 1 ? 'part is' : 'parts are'} released but missing the paired CAM file. Use <em>Admin → Export Queue</em> to batch-export, or open the part in SolidWorks to trigger an auto-export.
          </div>
        )}

        <div className="mfg-queue-tabs">
          {METHODS.map(m => (
            <button
              key={m}
              className={`mfg-queue-tab${tab === m ? ' active' : ''}`}
              onClick={() => setTab(m)}
            >
              {methodLabel(m)}
              <span className="mfg-queue-count">{counts[m] || 0}</span>
              {(needsExportCounts[m] || 0) > 0 && (
                <span className="mfg-queue-needs-export-pill" title="Parts missing their CAM export">
                  {needsExportCounts[m]}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading && <div className="mfg-queue-empty">Loading...</div>}
        {!loading && visible.length === 0 && (
          <div className="mfg-queue-empty">No parts queued for {methodLabel(tab)}.</div>
        )}

        {visible.length > 0 && (
          <div className="mfg-queue-list">
            {visible.map(item => (
              <div className={`mfg-queue-item${item.needsExport ? ' needs-export' : ''}`} key={item.path}>
                <div className="mfg-queue-main">
                  <div className="mfg-queue-path">
                    {item.path}
                    {item.needsExport && (
                      <span className="mfg-queue-needs-export-badge" title={`Expected file: ${item.expectedExportPath}`}>
                        Needs .{item.needsExport}
                      </span>
                    )}
                  </div>
                  <div className="mfg-queue-meta">
                    {item.material && <span><strong>Material:</strong> {item.material}</span>}
                    {typeof item.mass === 'number' && <span><strong>Mass:</strong> {item.mass.toFixed(2)} lb</span>}
                    {item.releasedBy && <span><strong>Released by:</strong> {item.releasedBy}</span>}
                    {item.releasedAt && <span>{relativeTime(item.releasedAt)}</span>}
                  </div>
                  {item.notes && <div className="mfg-queue-notes">{item.notes}</div>}
                </div>
                <button
                  className="toolbar-btn primary"
                  onClick={() => handleMarkManufactured(item.path)}
                  disabled={markingDone === item.path || !operatorReady}
                  title={!operatorReady ? 'Enter your initials at the top first' : undefined}
                >
                  {markingDone === item.path ? '...' : tab === 'purchase' ? 'Received' : 'Done'}
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <ErrorMsg text={error} />}

        <div className="actions">
          <button className="toolbar-btn" onClick={refresh}>Refresh</button>
          <button className="toolbar-btn primary" onClick={onClose}>Close</button>
        </div>
    </>
  )

  if (embedded) {
    // Full-screen Manufacturing View — no modal overlay, content
    // takes the whole available space
    return <div className="mfg-queue-embedded">{body}</div>
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal mfg-queue-modal" onClick={e => e.stopPropagation()}>
        {body}
      </div>
    </div>
  )
}
