import { useMemo, useState } from 'react'
import type { BulkMetaPatch, ReleaseState, ManufacturingMethod, PartMeta } from '@shared/types'

export interface JoinedPart {
  path: string
  partNumber: string
  type: string
  description?: string
  topLevel: string
  meta: PartMeta
}

export function topLevelOf(path: string): string {
  const i = path.indexOf('/')
  return i === -1 ? '(root)' : path.slice(0, i)
}

interface Props {
  loading: boolean
  parts: JoinedPart[]
  allParts: JoinedPart[]
  filter: string
  setFilter: (s: string) => void
  subsystem: string
  setSubsystem: (s: string) => void
  subsystemOptions: string[]
  state: ReleaseState | 'all'
  setState: (s: ReleaseState | 'all') => void
  pendingCount: number
  flushing: boolean
  flushNow: () => void
  onRefresh: () => void
  onSetRelease: (path: string, state: ReleaseState) => void
  onSetMethod: (path: string, m: ManufacturingMethod | null) => void
  onSetMaterial: (path: string, m: string) => void
  onSetMass: (path: string, mass: number | null) => void
  onSetCost: (path: string, cost: number | null) => void
  onBulkApply: (paths: string[], patch: BulkMetaPatch) => Promise<void>
}

export default function PartsManager(props: Props) {
  const {
    loading, parts, allParts, filter, setFilter, subsystem, setSubsystem,
    subsystemOptions, state, setState,
    pendingCount, flushing, flushNow,
    onRefresh, onSetRelease, onSetMethod, onSetMaterial, onSetMass, onSetCost,
    onBulkApply
  } = props

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkRelease, setBulkRelease] = useState<ReleaseState | ''>('')
  const [bulkMethod, setBulkMethod] = useState<ManufacturingMethod | '' | 'clear'>('')
  const [bulkMaterial, setBulkMaterial] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  const visiblePaths = useMemo(() => parts.map(p => p.path), [parts])
  const allVisibleSelected = visiblePaths.length > 0 && visiblePaths.every(p => selected.has(p))
  const someVisibleSelected = visiblePaths.some(p => selected.has(p))

  const toggleOne = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }
  const toggleAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        visiblePaths.forEach(p => next.delete(p))
      } else {
        visiblePaths.forEach(p => next.add(p))
      }
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const applyBulk = async () => {
    const patch: BulkMetaPatch = {}
    if (bulkRelease) patch.release = bulkRelease
    if (bulkMethod === 'clear') patch.manufacturingMethod = null
    else if (bulkMethod) patch.manufacturingMethod = bulkMethod
    if (bulkMaterial.trim()) patch.manufacturingMaterial = bulkMaterial.trim()
    if (Object.keys(patch).length === 0 || selected.size === 0) return
    const paths = Array.from(selected)
    setBulkBusy(true)
    try {
      await onBulkApply(paths, patch)
      setBulkRelease('')
      setBulkMethod('')
      setBulkMaterial('')
    } finally {
      setBulkBusy(false)
    }
  }

  const selectedCount = selected.size
  const nothingChosen = !bulkRelease && !bulkMethod && !bulkMaterial.trim()

  // Saving indicator: pendingCount is queued edits not yet flushed,
  // flushing is true while a commit/push is in flight.
  let saveStatus: string | null = null
  if (flushing) saveStatus = `Saving ${pendingCount > 0 ? pendingCount : ''} change${pendingCount === 1 ? '' : 's'}…`
  else if (pendingCount > 0) saveStatus = `${pendingCount} pending change${pendingCount === 1 ? '' : 's'}`

  return (
    <div className="admin-section">
      <h3>Parts Manager</h3>
      <p className="admin-hint">
        Inline-edit metadata for every part in the project. Edits apply
        immediately and batch into a single commit a moment after you stop
        typing. Tick rows to bulk-update release state, manufacturing
        method, or material across many parts at once.
      </p>
      <div className="parts-filter-row">
        <input
          placeholder="Search part #, file, description…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select value={subsystem} onChange={e => setSubsystem(e.target.value)}>
          <option value="all">All subsystems</option>
          {subsystemOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={state} onChange={e => setState(e.target.value as ReleaseState | 'all')}>
          <option value="all">All states</option>
          <option value="draft">draft</option>
          <option value="in-review">in-review</option>
          <option value="released">released</option>
          <option value="manufactured">manufactured</option>
        </select>
        <button className="toolbar-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <span className="parts-count">{parts.length} of {allParts.length}</span>
        {saveStatus && (
          <span className={`parts-save-status${flushing ? ' parts-save-status-active' : ''}`}>
            {saveStatus}
            {pendingCount > 0 && !flushing && (
              <button className="toolbar-btn-tiny" onClick={flushNow}>Save now</button>
            )}
          </span>
        )}
      </div>

      {selectedCount > 0 && (
        <div className="parts-bulk-bar">
          <span className="parts-bulk-count">{selectedCount} selected</span>
          <select
            value={bulkRelease}
            onChange={e => setBulkRelease(e.target.value as ReleaseState | '')}
            disabled={bulkBusy}
            title="Release state"
          >
            <option value="">Release…</option>
            <option value="draft">draft</option>
            <option value="in-review">in-review</option>
            <option value="released">released</option>
            <option value="manufactured">manufactured</option>
          </select>
          <select
            value={bulkMethod}
            onChange={e => setBulkMethod(e.target.value as ManufacturingMethod | '' | 'clear')}
            disabled={bulkBusy}
            title="Manufacturing method"
          >
            <option value="">Method…</option>
            <option value="print">3D Print</option>
            <option value="cnc">CNC</option>
            <option value="manual">Hand</option>
            <option value="purchase">Purchase</option>
            <option value="other">Other</option>
            <option value="clear">(clear)</option>
          </select>
          <input
            type="text"
            list="default-materials"
            value={bulkMaterial}
            onChange={e => setBulkMaterial(e.target.value)}
            placeholder="Material…"
            disabled={bulkBusy}
          />
          <button
            className="toolbar-btn primary"
            onClick={applyBulk}
            disabled={bulkBusy || nothingChosen}
          >
            {bulkBusy ? 'Saving…' : `Apply to ${selectedCount}`}
          </button>
          <button className="toolbar-btn" onClick={clearSelection} disabled={bulkBusy}>
            Clear
          </button>
        </div>
      )}

      {loading && <div className="admin-status">Loading parts…</div>}
      {!loading && parts.length === 0 && (
        <div className="admin-status">
          {allParts.length === 0 ? 'No parts in this project yet.' : 'No parts match the current filter.'}
        </div>
      )}
      {!loading && parts.length > 0 && (
        <div className="parts-table-wrap">
          <table className="parts-table">
            <thead>
              <tr>
                <th className="parts-cell-select">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={el => { if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected }}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible parts"
                  />
                </th>
                <th>Part #</th>
                <th>File</th>
                <th>Subsystem</th>
                <th>Release</th>
                <th>Method</th>
                <th>Material</th>
                <th>Mass (lb)</th>
                <th>Cost ($)</th>
              </tr>
            </thead>
            <tbody>
              {parts.map(p => {
                const filename = p.path.includes('/') ? p.path.slice(p.path.lastIndexOf('/') + 1) : p.path
                const isSelected = selected.has(p.path)
                return (
                  <tr key={p.path} className={isSelected ? 'parts-row-selected' : ''}>
                    <td className="parts-cell-select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(p.path)}
                        aria-label={`Select ${p.partNumber}`}
                      />
                    </td>
                    <td className="parts-cell-pn">{p.partNumber}</td>
                    <td className="parts-cell-file" title={p.path}>{filename}</td>
                    <td>{p.topLevel}</td>
                    <td>
                      <select
                        value={p.meta.release?.state ?? 'draft'}
                        onChange={e => onSetRelease(p.path, e.target.value as ReleaseState)}
                      >
                        <option value="draft">draft</option>
                        <option value="in-review">in-review</option>
                        <option value="released">released</option>
                        <option value="manufactured">manufactured</option>
                      </select>
                    </td>
                    <td>
                      <select
                        value={p.meta.manufacturingMethod ?? ''}
                        onChange={e => onSetMethod(p.path, e.target.value ? e.target.value as ManufacturingMethod : null)}
                      >
                        <option value="">—</option>
                        <option value="print">3D Print</option>
                        <option value="cnc">CNC</option>
                        <option value="manual">Hand</option>
                        <option value="purchase">Purchase</option>
                        <option value="other">Other</option>
                      </select>
                    </td>
                    <td>
                      {/* Material/Mass/Cost are uncontrolled (defaultValue) so
                          typing isn't clobbered by re-renders — keying each
                          input on the saved value remounts it when a refresh/
                          sync reloads meta, so reloaded values actually show. */}
                      <input
                        key={`${p.path}:mat:${p.meta.manufacturingMaterial ?? ''}`}
                        type="text"
                        list="default-materials"
                        defaultValue={p.meta.manufacturingMaterial ?? ''}
                        onBlur={e => {
                          const v = e.target.value.trim()
                          if (v !== (p.meta.manufacturingMaterial ?? '')) onSetMaterial(p.path, v)
                        }}
                        placeholder="—"
                      />
                    </td>
                    <td>
                      <input
                        key={`${p.path}:mass:${p.meta.mass ?? ''}`}
                        type="number"
                        step="0.001"
                        min="0"
                        defaultValue={typeof p.meta.mass === 'number' ? p.meta.mass : ''}
                        onBlur={e => {
                          const raw = e.target.value.trim()
                          const parsed = raw === '' ? null : parseFloat(raw)
                          const same = (parsed === null && typeof p.meta.mass !== 'number') ||
                            (parsed !== null && parsed === p.meta.mass)
                          if (!same) onSetMass(p.path, parsed)
                        }}
                      />
                    </td>
                    <td>
                      <input
                        key={`${p.path}:cost:${p.meta.cost ?? ''}`}
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={typeof p.meta.cost === 'number' ? p.meta.cost : ''}
                        onBlur={e => {
                          const raw = e.target.value.trim()
                          const parsed = raw === '' ? null : parseFloat(raw)
                          const same = (parsed === null && typeof p.meta.cost !== 'number') ||
                            (parsed !== null && parsed === p.meta.cost)
                          if (!same) onSetCost(p.path, parsed)
                        }}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
