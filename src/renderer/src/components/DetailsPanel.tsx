import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import type { BulkMetaPatch, FileEntry, FileState, ManufacturingMethod, PartMeta, PartPurchaseInfo, PurchaseStatus, ReleaseState } from '@shared/types'
import FileThumbnail from './FileThumbnail'
import ErrorMsg from './ErrorMsg'

interface Props {
  file: FileEntry | null
  onCheckOut: (path: string) => void
  onCheckIn: (path: string) => void
  /** Optional close handler — only wired when the panel is rendered
   *  as an overlay (medium/compact responsive tiers). When unset the
   *  panel is inline and never shows a close button. */
  onClose?: () => void
  /** Jump-to-file callback used by the Where Used list. Wired by the
   *  parent so clicking an assembly there selects it in the file tree. */
  onNavigate?: (path: string) => void
  /** Mentor/admin gate. Students can only move release state between
   *  draft and in-review; sign-off transitions (released, manufactured,
   *  and any downgrade out of those) require mentor or above. */
  isMentor?: boolean
  /** When true, git operations are in progress — disable action buttons. */
  isLoading?: boolean
}

function stateLabel(state: FileState): string {
  switch (state) {
    case 'synced': return 'Up to date'
    case 'modified': return 'Modified locally'
    case 'untracked': return 'New file'
    case 'locked-by-you': return 'Checked out by you'
    case 'locked-by-other': return 'Checked out'
  }
}

function fileType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'sldprt': return 'SolidWorks Part'
    case 'sldasm': return 'SolidWorks Assembly'
    case 'slddrw': return 'SolidWorks Drawing'
    case 'step': case 'stp': return 'STEP File'
    case 'stl': return 'STL Mesh'
    case 'pdf': return 'PDF Document'
    case 'png': case 'jpg': case 'jpeg': return 'Image'
    default: return ext?.toUpperCase() || 'File'
  }
}

const RELEASE_STATES: ReleaseState[] = ['draft', 'in-review', 'released', 'manufactured']

function releaseLabel(s: ReleaseState | undefined): string {
  if (!s) return 'Draft'
  switch (s) {
    case 'draft': return 'Draft'
    case 'in-review': return 'In Review'
    case 'released': return 'Released'
    case 'manufactured': return 'Manufactured'
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}

export default function DetailsPanel({ file, onCheckOut, onCheckIn, onClose, onNavigate, isMentor = true, isLoading = false }: Props) {
  const [meta, setMeta] = useState<PartMeta>({})
  const [loading, setLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [posting, setPosting] = useState(false)
  const [mfgNotes, setMfgNotes] = useState('')
  const [mfgMaterial, setMfgMaterial] = useState('')
  const [mfgMethod, setMfgMethod] = useState<ManufacturingMethod | null>(null)
  const [massText, setMassText] = useState('')
  const [costText, setCostText] = useState('')
  const [savingState, setSavingState] = useState<ReleaseState | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Last-write-wins guard: a blur-save on file A then a quick switch to file B
  // can resolve A's getPartMeta after B's and paint A's metadata under B.
  // Track the most-recent requested path and ignore stale resolutions.
  const metaReqRef = useRef('')
  const refreshMeta = useCallback(async (path: string) => {
    metaReqRef.current = path
    setLoading(true)
    try {
      const m = await window.api.getPartMeta(path)
      if (metaReqRef.current !== path) return // a newer refresh superseded this
      setMeta(m || {})
      setMfgNotes(m?.manufacturingNotes || '')
      setMfgMaterial(m?.manufacturingMaterial || '')
      setMfgMethod(m?.manufacturingMethod ?? null)
      setMassText(typeof m?.mass === 'number' ? String(m.mass) : '')
      setCostText(typeof m?.cost === 'number' ? String(m.cost) : '')
    } catch {
      setMeta({})
      setMfgNotes('')
      setMfgMaterial('')
      setMfgMethod(null)
      setMassText('')
      setCostText('')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (file && !file.isDirectory) refreshMeta(file.path)
  }, [file, refreshMeta])

  // Purchasing details persist immediately (separate from the dirty-patch save
  // bar) — each field saves on blur, the status on change.
  const savePurchase = useCallback(async (patch: PartPurchaseInfo) => {
    if (!file) return
    try {
      await window.api.setPurchaseInfo(file.path, patch)
      await refreshMeta(file.path)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [file, refreshMeta])

  // Where-used: list of assemblies that contain this part (folder
  // heuristic, see main/parts.ts findWhereUsed). Loads in parallel with
  // the part meta, doesn't block the rest of the panel rendering.
  // Keyed on path (not `file`) so a chokidar-driven files refresh that
  // just hands us a new FileEntry object for the same path doesn't
  // trigger a redundant IPC.
  const [whereUsed, setWhereUsed] = useState<string[]>([])
  const filePath = file?.path
  const isDir = !!file?.isDirectory
  useEffect(() => {
    if (!filePath || isDir) { setWhereUsed([]); return }
    let cancelled = false
    window.api.getWhereUsed(filePath)
      .then(list => { if (!cancelled) setWhereUsed(list) })
      .catch(() => { if (!cancelled) setWhereUsed([]) })
    return () => { cancelled = true }
  }, [filePath, isDir])

  if (!file) {
    return (
      <div className="details-panel">
        {onClose && (
          <button className="details-overlay-close" onClick={onClose} title="Close details" aria-label="Close details">
            <X size={16} strokeWidth={2} />
          </button>
        )}
        <div className="details-empty">
          Click a file to see details
        </div>
      </div>
    )
  }

  const canCheckOut = !file.isDirectory &&
    file.state !== 'locked-by-you' && file.state !== 'locked-by-other'

  const canCheckIn = file.state === 'locked-by-you'

  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '/'

  const currentState: ReleaseState = meta.release?.state || 'draft'

  const handleSetState = async (state: ReleaseState) => {
    if (state === currentState) return
    setSavingState(state)
    setError(null)
    try {
      await window.api.setReleaseState(file.path, state)
      await refreshMeta(file.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingState(null)
    }
  }

  const handlePostComment = async () => {
    const text = commentText.trim()
    if (!text) return
    setPosting(true)
    setError(null)
    try {
      await window.api.addComment(file.path, text)
      setCommentText('')
      await refreshMeta(file.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPosting(false)
    }
  }

  const parseNumber = (text: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } => {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: true, value: null }
    const parsed = parseFloat(trimmed)
    if (isNaN(parsed) || parsed < 0) return { ok: false, error: `${label} must be a positive number` }
    return { ok: true, value: parsed }
  }

  const massParsed = parseNumber(massText, 'Mass')
  const costParsed = parseNumber(costText, 'Cost')

  // Dirty = any of the meta fields differ from the last server-fetched
  // meta. Comments and release-state aren't covered here — they have
  // their own Post / pill actions that commit immediately.
  const massSaved = typeof meta.mass === 'number' ? meta.mass : null
  const costSaved = typeof meta.cost === 'number' ? meta.cost : null
  const massDirty = massParsed.ok && massParsed.value !== massSaved
  const costDirty = costParsed.ok && costParsed.value !== costSaved
  const materialDirty = mfgMaterial !== (meta.manufacturingMaterial || '')
  const methodDirty = mfgMethod !== (meta.manufacturingMethod ?? null)
  const notesDirty = mfgNotes !== (meta.manufacturingNotes || '')
  const dirty = massDirty || costDirty || materialDirty || methodDirty || notesDirty
  const hasInputError = !massParsed.ok || !costParsed.ok

  const handleSaveMeta = async () => {
    if (!dirty || hasInputError) return
    setError(null)
    setSaveStatus(null)
    setSavingMeta(true)
    try {
      // Build one patch covering every dirty field and ship it through
      // bulkUpdateMeta so we get exactly one git commit + push for the
      // whole Save click instead of one per field.
      const patch: BulkMetaPatch = {}
      if (massDirty && massParsed.ok) patch.mass = massParsed.value
      if (costDirty && costParsed.ok) patch.cost = costParsed.value
      if (materialDirty) patch.manufacturingMaterial = mfgMaterial
      if (methodDirty) patch.manufacturingMethod = mfgMethod
      if (notesDirty) patch.manufacturingNotes = mfgNotes
      if (Object.keys(patch).length > 0) {
        await window.api.bulkUpdateMeta({ [file.path]: patch })
      }
      await refreshMeta(file.path)
      setSaveStatus('Saved')
      setTimeout(() => setSaveStatus(s => (s === 'Saved' ? null : s)), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingMeta(false)
    }
  }

  const handleRevertMeta = () => {
    setMassText(typeof meta.mass === 'number' ? String(meta.mass) : '')
    setCostText(typeof meta.cost === 'number' ? String(meta.cost) : '')
    setMfgMaterial(meta.manufacturingMaterial || '')
    setMfgMethod(meta.manufacturingMethod ?? null)
    setMfgNotes(meta.manufacturingNotes || '')
    setError(null)
  }

  const inputError = !massParsed.ok ? massParsed.error : !costParsed.ok ? costParsed.error : null

  return (
    <div className="details-panel">
      {onClose && (
        <button className="details-overlay-close" onClick={onClose} title="Close details" aria-label="Close details">
          <X size={16} strokeWidth={2} />
        </button>
      )}
      <div className="details-header">
        {!file.isDirectory && (
          <FileThumbnail
            path={file.path}
            size={200}
            className="details-thumb"
            fallback={null}
          />
        )}
        <div className="file-name">{file.name}</div>
        <div className="file-path">{dir}</div>
      </div>

      <div className="details-section">
        <div className="section-title">Info</div>
        <div className="details-row">
          <span className="label">Type</span>
          <span className="value">{file.isDirectory ? 'Folder' : fileType(file.name)}</span>
        </div>
        {file.partNumber && (
          <div className="details-row">
            <span className="label">Part #</span>
            <span className="value part-number-detail">{file.partNumber}</span>
          </div>
        )}
        {file.partDescription && (
          <div className="details-row">
            <span className="label">Description</span>
            <span className="value">{file.partDescription}</span>
          </div>
        )}
        <div className="details-row">
          <span className="label">Status</span>
          <span className="value">{stateLabel(file.state)}</span>
        </div>
        {file.lockedBy && (
          <div className="details-row">
            <span className="label">Locked by</span>
            <span className="value">{file.lockedBy}</span>
          </div>
        )}
      </div>

      {!file.isDirectory && whereUsed.length > 0 && (
        <div className="details-section">
          <div className="section-title">Where Used</div>
          <ul className="where-used-list">
            {whereUsed.map(p => {
              const base = p.split('/').pop() ?? p
              return (
                <li key={p}>
                  <button
                    className="where-used-link"
                    onClick={() => onNavigate?.(p)}
                    title={p}
                    disabled={!onNavigate}
                  >
                    {base}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {!file.isDirectory && (
        <>
          <div className="details-section">
            <div className="section-title">Release</div>
            <div className="release-row">
              <span className={`release-badge release-${currentState}`}>{releaseLabel(currentState)}</span>
              {meta.release?.at && (
                <span className="release-meta">
                  {meta.release.by ? `by ${meta.release.by} · ` : ''}{formatTime(meta.release.at)}
                </span>
              )}
            </div>
            {meta.release?.note && (
              <div className="release-meta" style={{ marginBottom: 6 }}>{meta.release.note}</div>
            )}
            {meta.release?.location && (
              <div className="release-meta" style={{ marginBottom: 6 }}>📍 Located at <strong>{meta.release.location}</strong></div>
            )}
            <div className="release-buttons">
              {RELEASE_STATES.map(s => {
                // Students can only flip between draft and in-review.
                // Anything that's already been signed off (released or
                // manufactured) is locked for them — only mentors can
                // touch those transitions in either direction.
                const studentBlocked =
                  !isMentor && (
                    s === 'released' ||
                    s === 'manufactured' ||
                    currentState === 'released' ||
                    currentState === 'manufactured'
                  )
                return (
                  <button
                    key={s}
                    className={`release-pill release-${s}${currentState === s ? ' active' : ''}`}
                    onClick={() => handleSetState(s)}
                    disabled={loading || savingState !== null || studentBlocked}
                    title={studentBlocked ? 'Only mentors can set this state' : undefined}
                  >
                    {savingState === s ? '...' : releaseLabel(s)}
                  </button>
                )
              })}
            </div>
            {!isMentor && (currentState === 'released' || currentState === 'manufactured') && (
              <div className="admin-hint" style={{ marginTop: 6 }}>
                A mentor has signed off on this part. Only a mentor can change its release state now.
              </div>
            )}
          </div>

          <div className="details-section">
            <div className="section-title">
              Comments {meta.comments && meta.comments.length > 0 ? `(${meta.comments.length})` : ''}
            </div>
            <div className="comments-list">
              {(meta.comments || []).map(c => (
                <div className="comment" key={c.id}>
                  <div className="comment-head">
                    <span className="comment-author">{c.author}</span>
                    <span className="comment-time">{formatTime(c.at)}</span>
                  </div>
                  <div className="comment-body">{c.text}</div>
                </div>
              ))}
              {(!meta.comments || meta.comments.length === 0) && (
                <div className="comments-empty">No comments yet</div>
              )}
            </div>
            <div className="comment-form">
              <textarea
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
              />
              <button
                className="toolbar-btn primary"
                onClick={handlePostComment}
                disabled={!commentText.trim() || posting}
              >
                {posting ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>

          <div className="details-section">
            <div className="section-title">Mass & Cost</div>
            <div className="mass-cost-grid">
              <label className="mass-cost-field">
                <span>Mass (lb)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={massText}
                  onChange={e => setMassText(e.target.value)}
                  placeholder="0.0"
                />
              </label>
              <label className="mass-cost-field">
                <span>Cost ($)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={costText}
                  onChange={e => setCostText(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            </div>
          </div>

          <div className="details-section">
            <div className="section-title">Manufacturing Method</div>
            <div className="mfg-method-row">
              {(['print', 'cnc', 'manual', 'purchase', 'other'] as ManufacturingMethod[]).map(m => (
                <button
                  key={m}
                  className={`mfg-method-pill${mfgMethod === m ? ' active' : ''}`}
                  onClick={() => setMfgMethod(mfgMethod === m ? null : m)}
                  disabled={savingMeta}
                >
                  {m === 'print' ? '3D Print' : m === 'cnc' ? 'CNC' : m === 'manual' ? 'Hand' : m === 'purchase' ? 'Purchase' : 'Other'}
                </button>
              ))}
            </div>
            <input
              className="mfg-material-input"
              list="default-materials"
              placeholder="Material (e.g. 6061-T6 Aluminum, Polycarb, N/A)"
              value={mfgMaterial}
              onChange={e => setMfgMaterial(e.target.value)}
              disabled={savingMeta}
            />
          </div>

          {mfgMethod === 'purchase' && (
            <div className="details-section">
              <div className="section-title">Purchasing</div>
              <div className="purchase-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input key={`pv-${file.path}`} defaultValue={meta.purchase?.vendor ?? ''} placeholder="Vendor"
                  onBlur={e => savePurchase({ vendor: e.target.value })} />
                <input key={`ps-${file.path}`} defaultValue={meta.purchase?.sku ?? ''} placeholder="Vendor part # / SKU"
                  onBlur={e => savePurchase({ sku: e.target.value })} />
                <input key={`pq-${file.path}`} type="number" min="0" defaultValue={meta.purchase?.qty ?? ''} placeholder="Qty"
                  onBlur={e => savePurchase({ qty: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <input key={`pc-${file.path}`} type="number" min="0" step="0.01" defaultValue={meta.purchase?.unitCost ?? ''} placeholder="Unit cost ($)"
                  onBlur={e => savePurchase({ unitCost: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <input key={`pu-${file.path}`} defaultValue={meta.purchase?.url ?? ''} placeholder="Product / order URL" style={{ gridColumn: '1 / -1' }}
                  onBlur={e => savePurchase({ url: e.target.value })} />
                <select value={meta.purchase?.status ?? 'to-order'} style={{ gridColumn: '1 / -1' }}
                  onChange={e => savePurchase({ status: e.target.value as PurchaseStatus })}>
                  <option value="to-order">To order</option>
                  <option value="ordered">Ordered</option>
                  <option value="received">Received</option>
                </select>
              </div>
            </div>
          )}

          <div className="details-section">
            <div className="section-title">Manufacturing Notes</div>
            <textarea
              className="mfg-notes-input"
              value={mfgNotes}
              onChange={e => setMfgNotes(e.target.value)}
              placeholder="e.g., 1/4&quot; 6061, deburr edges"
              rows={3}
              disabled={savingMeta}
            />
          </div>

          <div className="details-save-bar">
            <span className="details-save-status">
              {inputError ? inputError : dirty ? 'Unsaved changes' : saveStatus || ''}
            </span>
            <button
              className="toolbar-btn"
              onClick={handleRevertMeta}
              disabled={!dirty || savingMeta}
            >
              Revert
            </button>
            <button
              className="toolbar-btn primary"
              onClick={handleSaveMeta}
              disabled={!dirty || hasInputError || savingMeta}
            >
              {savingMeta ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {error && <ErrorMsg text={error} className="details-error" />}

      {!file.isDirectory && (
        <div className="details-actions">
          {canCheckOut && (
            <button className="toolbar-btn" onClick={() => onCheckOut(file.path)} disabled={isLoading}>
              Check Out
            </button>
          )}
          {canCheckIn && (
            <button className="toolbar-btn" onClick={() => onCheckIn(file.path)} disabled={isLoading}>
              Check In
            </button>
          )}
          <button className="toolbar-btn" onClick={() => window.api.openFileExplorer(file.path)}>
            Show in Explorer
          </button>
        </div>
      )}
    </div>
  )
}
