import { useState, useEffect, useMemo, useCallback, useRef, memo, type ReactNode } from 'react'
import type { BulkMetaPatch, FileEntry, FileState, ManufacturingMethod, ReleaseState } from '@shared/types'
import FileThumbnail from './FileThumbnail'

interface Props {
  files: FileEntry[]
  selectedFile: FileEntry | null
  onSelect: (file: FileEntry) => void
  onCheckOut: (path: string) => void
  onCheckIn: (path: string) => void
  /** Bulk-apply a metadata patch across many files in a single commit.
   *  Wired to the same useParts.bulkApply path that the Parts Manager
   *  uses, so file-tree bulk edits stack onto the team queue identically. */
  onBulkApply?: (paths: string[], patch: BulkMetaPatch) => Promise<void>
}

interface ContextMenuState {
  x: number
  y: number
  file: FileEntry
}

type SortKey = 'name' | 'partnum' | 'status' | 'lockedby'
type SortDir = 'asc' | 'desc'

function stateLabel(state: FileState): string {
  switch (state) {
    case 'synced': return 'Up to date'
    case 'modified': return 'Modified'
    case 'untracked': return 'New'
    case 'locked-by-you': return 'Checked out'
    case 'locked-by-other': return 'Locked'
  }
}

const STATE_ORDER: Record<FileState, number> = {
  'locked-by-other': 0,
  'locked-by-you': 1,
  'modified': 2,
  'untracked': 3,
  'synced': 4
}

function fileIcon(entry: FileEntry): string {
  if (entry.isDirectory) return '\u{1F4C1}'
  const ext = entry.name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'sldprt': return 'P'
    case 'sldasm': return 'A'
    case 'slddrw': return 'D'
    case 'step': case 'stp': return 'S'
    case 'stl': return '△'
    case 'pdf': return '□'
    default: return '□'
  }
}

// Split "Foo.sldprt" into ["Foo", ".sldprt"] so the extension can be
// rendered in a slightly smaller font than the base name. Files with
// no dot just render as-is. Hidden dotfiles like ".gitignore" keep
// their leading dot in the base — only the *last* dot counts.
function renderFilename(name: string): ReactNode {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) return name
  return (
    <>
      {name.slice(0, lastDot)}
      <span className="file-ext">{name.slice(lastDot)}</span>
    </>
  )
}

function fileIconTitle(entry: FileEntry): string {
  if (entry.isDirectory) return 'Folder'
  const ext = entry.name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'sldprt': return 'Part'
    case 'sldasm': return 'Assembly'
    case 'slddrw': return 'Drawing'
    case 'step': case 'stp': return 'STEP'
    case 'stl': return 'STL'
    case 'pdf': return 'PDF'
    default: return 'File'
  }
}

interface FileRowProps {
  path: string
  name: string
  isDirectory: boolean
  depth: number
  selected: boolean
  collapsed: boolean
  state: FileState
  partNumber: string | undefined
  releaseState: ReleaseState | undefined
  commentCount: number | undefined
  lockedBy: string | undefined
  iconChar: string
  iconTitle: string
  /** For folder rows: count of modified/untracked descendants — used
   *  to remind the user there are unpublished changes inside even when
   *  the folder is collapsed. Undefined or 0 = no indicator. */
  dirtyDescendants?: number
  /** Multi-select bulk-edit state. `checked` is true when this row is
   *  ticked; `indeterminate` is true for folders where some-but-not-all
   *  descendants are ticked. `showCheckbox` is true when bulk-edit is
   *  wired (parent supplied onBulkApply). */
  showCheckbox: boolean
  checked: boolean
  indeterminate: boolean
  onToggleSelect: (path: string) => void
  onClick: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string) => void
}

const FileRow = memo(function FileRow({
  path, name, isDirectory, depth, selected, collapsed,
  state, partNumber, releaseState, commentCount, lockedBy,
  iconChar, iconTitle, dirtyDescendants,
  showCheckbox, checked, indeterminate, onToggleSelect,
  onClick, onContextMenu
}: FileRowProps) {
  return (
    <div
      className={`file-row${selected ? ' selected' : ''}${checked ? ' bulk-selected' : ''}`}
      onClick={() => onClick(path)}
      onContextMenu={e => onContextMenu(e, path)}
    >
      {showCheckbox && (
        <div className="col-select" onClick={e => { e.stopPropagation(); onToggleSelect(path) }}>
          <input
            type="checkbox"
            checked={checked}
            ref={el => { if (el) el.indeterminate = indeterminate && !checked }}
            onChange={() => onToggleSelect(path)}
            onClick={e => e.stopPropagation()}
            aria-label={`Select ${name}`}
          />
        </div>
      )}
      <div className="col-name">
        <span className="indent" style={{ width: depth * 20 }} />
        {isDirectory ? (
          <span className="expand-toggle">{collapsed ? '▸' : '▾'}</span>
        ) : (
          <span className="expand-toggle" />
        )}
        {isDirectory ? (
          <span className="icon" title={iconTitle}>{iconChar}</span>
        ) : (
          <FileThumbnail
            path={path}
            size={24}
            className="icon thumb"
            title={iconTitle}
            fallback={<span className="icon" title={iconTitle}>{iconChar}</span>}
          />
        )}
        <span className={`name${isDirectory ? ' folder' : ''}`}>
          {isDirectory ? name : renderFilename(name)}
        </span>
        {isDirectory && dirtyDescendants && dirtyDescendants > 0 ? (
          <span
            className="folder-dirty-badge"
            title={`${dirtyDescendants} unpublished change${dirtyDescendants === 1 ? '' : 's'} inside — remember to Publish`}
          >
            {dirtyDescendants}
          </span>
        ) : null}
      </div>
      <div className="col-partnum">
        {!isDirectory && partNumber && (
          <span className="part-number">{partNumber}</span>
        )}
      </div>
      <div className="col-status">
        {!isDirectory && (
          <>
            <span className={`status-dot ${state}`} />
            <span className={`status-label ${state}`}>{stateLabel(state)}</span>
            {releaseState && releaseState !== 'draft' && (
              <span
                className={`release-dot release-${releaseState}`}
                title={`Release: ${releaseState}`}
              />
            )}
            {commentCount && commentCount > 0 && (
              <span className="comment-count" title={`${commentCount} comment(s)`}>
                {commentCount}
              </span>
            )}
          </>
        )}
      </div>
      <div className="col-lock">{lockedBy || ''}</div>
    </div>
  )
})

function compareEntries(a: FileEntry, b: FileEntry, key: SortKey, dir: SortDir): number {
  // Directories always come first regardless of sort
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1

  let cmp = 0
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name)
      break
    case 'partnum':
      cmp = (a.partNumber || '').localeCompare(b.partNumber || '')
      break
    case 'status':
      cmp = STATE_ORDER[a.state] - STATE_ORDER[b.state]
      if (cmp === 0) cmp = a.name.localeCompare(b.name)
      break
    case 'lockedby':
      cmp = (a.lockedBy || '').localeCompare(b.lockedBy || '')
      if (cmp === 0) cmp = a.name.localeCompare(b.name)
      break
  }
  return dir === 'asc' ? cmp : -cmp
}

function sortTree(entries: FileEntry[], key: SortKey, dir: SortDir): FileEntry[] {
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, key, dir))
  return sorted.map(e => e.children
    ? { ...e, children: sortTree(e.children, key, dir) }
    : e)
}

function flattenTree(entries: FileEntry[], depth: number, collapsed: Set<string>): { entry: FileEntry; depth: number }[] {
  const result: { entry: FileEntry; depth: number }[] = []
  for (const entry of entries) {
    result.push({ entry, depth })
    if (entry.isDirectory && entry.children && !collapsed.has(entry.path)) {
      result.push(...flattenTree(entry.children, depth + 1, collapsed))
    }
  }
  return result
}

function matchesSearch(entry: FileEntry, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (entry.name.toLowerCase().includes(q)) return true
  if (entry.partNumber && entry.partNumber.toLowerCase().includes(q)) return true
  if (entry.partDescription && entry.partDescription.toLowerCase().includes(q)) return true
  if (entry.path.toLowerCase().includes(q)) return true
  return false
}

function filterTree(entries: FileEntry[], query: string): FileEntry[] {
  if (!query) return entries
  const out: FileEntry[] = []
  for (const e of entries) {
    if (e.isDirectory && e.children) {
      const kids = filterTree(e.children, query)
      if (kids.length > 0 || matchesSearch(e, query)) {
        out.push({ ...e, children: kids })
      }
    } else if (matchesSearch(e, query)) {
      out.push(e)
    }
  }
  return out
}

export default function ProjectBrowser({ files, selectedFile, onSelect, onCheckOut, onCheckIn, onBulkApply }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Multi-select state for bulk metadata edits. Stored as a Set of
  // every checked path — file or folder. The "what to apply patches
  // to" resolution happens at apply-time so a folder check expands
  // to its descendant files lazily.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())
  const [bulkRelease, setBulkRelease] = useState<ReleaseState | ''>('')
  const [bulkMethod, setBulkMethod] = useState<ManufacturingMethod | '' | 'clear'>('')
  const [bulkMaterial, setBulkMaterial] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)
  const bulkEnabled = !!onBulkApply
  const didInitialCollapse = useRef(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  const toggleCollapse = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const filteredFiles = useMemo(
    () => filterTree(files, search.trim()),
    [files, search]
  )
  const sortedFiles = useMemo(
    () => sortTree(filteredFiles, sortKey, sortDir),
    [filteredFiles, sortKey, sortDir]
  )
  // Expand all when there's a search query so matches are visible
  const rows = useMemo(() => {
    const effectiveCollapsed = search.trim() ? new Set<string>() : collapsed
    return flattenTree(sortedFiles, 0, effectiveCollapsed)
  }, [sortedFiles, collapsed, search])

  const selectedPath = selectedFile?.path

  // Path → entry map so memoized FileRow click handlers can look up
  // the FileEntry without us recreating the closure per row each render.
  const entryByPath = useMemo(() => {
    const map = new Map<string, FileEntry>()
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        map.set(e.path, e)
        if (e.children) walk(e.children)
      }
    }
    walk(files)
    return map
  }, [files])

  const handleRowClick = useCallback((path: string) => {
    const entry = entryByPath.get(path)
    if (!entry) return
    if (entry.isDirectory) toggleCollapse(path)
    else onSelect(entry)
  }, [entryByPath, onSelect])

  const handleRowContext = useCallback((e: React.MouseEvent, path: string) => {
    const entry = entryByPath.get(path)
    if (!entry) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file: entry })
  }, [entryByPath])

  // Map every folder path to the recursive set of file (non-directory)
  // descendants underneath it. Used both for the toggle-folder selection
  // logic and for the indeterminate-state computation. Recomputed only
  // when the file tree changes.
  const fileDescendants = useMemo(() => {
    const map = new Map<string, string[]>()
    const collect = (entries: FileEntry[]): string[] => {
      const out: string[] = []
      for (const e of entries) {
        if (e.isDirectory) {
          const kids = collect(e.children || [])
          map.set(e.path, kids)
          out.push(...kids)
        } else {
          out.push(e.path)
        }
      }
      return out
    }
    collect(files)
    return map
  }, [files])

  const toggleBulkSelect = useCallback((path: string) => {
    setBulkSelected(prev => {
      const next = new Set(prev)
      const entry = entryByPath.get(path)
      if (!entry) return prev
      if (entry.isDirectory) {
        // Selecting a folder = selecting every file under it. Toggling
        // collapses to "all on" → "all off" based on whether every
        // descendant is already in the set.
        const descs = fileDescendants.get(path) || []
        const allOn = descs.length > 0 && descs.every(d => next.has(d))
        if (allOn) {
          descs.forEach(d => next.delete(d))
          next.delete(path)
        } else {
          descs.forEach(d => next.add(d))
          next.add(path)
        }
      } else {
        if (next.has(path)) next.delete(path); else next.add(path)
      }
      return next
    })
  }, [entryByPath, fileDescendants])

  const clearBulkSelection = useCallback(() => setBulkSelected(new Set()), [])

  // Final list of file paths to apply patches to. Folders in the
  // selection are dropped here — only file leaves carry metadata.
  const selectedFilePaths = useMemo(() => {
    const out: string[] = []
    for (const p of bulkSelected) {
      const entry = entryByPath.get(p)
      if (entry && !entry.isDirectory) out.push(p)
    }
    return out
  }, [bulkSelected, entryByPath])

  const applyBulk = async () => {
    if (!onBulkApply || selectedFilePaths.length === 0) return
    const patch: BulkMetaPatch = {}
    if (bulkRelease) patch.release = bulkRelease
    if (bulkMethod === 'clear') patch.manufacturingMethod = null
    else if (bulkMethod) patch.manufacturingMethod = bulkMethod
    if (bulkMaterial.trim()) patch.manufacturingMaterial = bulkMaterial.trim()
    if (Object.keys(patch).length === 0) return
    setBulkApplying(true)
    try {
      await onBulkApply(selectedFilePaths, patch)
      setBulkRelease('')
      setBulkMethod('')
      setBulkMaterial('')
      clearBulkSelection()
    } catch {
      // useParts surfaces errors via the parts.error banner
    } finally {
      setBulkApplying(false)
    }
  }

  const bulkNothingChosen = !bulkRelease && !bulkMethod && !bulkMaterial.trim()

  // Count unpublished files (modified or untracked) per folder so we
  // can badge collapsed folders that are hiding pending changes.
  // Each folder's count = number of dirty leaves anywhere in its subtree.
  const dirtyByFolder = useMemo(() => {
    const counts = new Map<string, number>()
    const isDirty = (s: FileState) => s === 'modified' || s === 'untracked'
    const walk = (entries: FileEntry[]): number => {
      let subtreeDirty = 0
      for (const e of entries) {
        if (e.isDirectory) {
          const childDirty = walk(e.children || [])
          if (childDirty > 0) counts.set(e.path, childDirty)
          subtreeDirty += childDirty
        } else if (isDirty(e.state)) {
          subtreeDirty += 1
        }
      }
      return subtreeDirty
    }
    walk(files)
    return counts
  }, [files])

  const allFolderPaths = useMemo(() => {
    const out: string[] = []
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        if (e.isDirectory) {
          out.push(e.path)
          if (e.children) walk(e.children)
        }
      }
    }
    walk(files)
    return out
  }, [files])

  // Default the tree to fully collapsed the first time folders show up
  // for this mount. After that, leave the user's expand/collapse
  // choices alone — new folders that arrive on a sync stay expanded so
  // the user can see what was added.
  //
  // Previously this used a 1500ms grace-period timer that marked the
  // collapse "spent" even when no folders had appeared yet. For
  // medium-sized clones the file watcher can take longer than that to
  // report its first batch, leaving the tree fully expanded on load.
  // Now we just wait — auto-collapse fires whenever folders first
  // appear, even if it takes 30 seconds.
  useEffect(() => {
    if (didInitialCollapse.current) return
    if (allFolderPaths.length === 0) return
    setCollapsed(new Set(allFolderPaths))
    didInitialCollapse.current = true
  }, [allFolderPaths])

  const collapseAll = () => setCollapsed(new Set(allFolderPaths))
  const expandAll = () => setCollapsed(new Set())

  const canCheckOut = contextMenu?.file && !contextMenu.file.isDirectory &&
    contextMenu.file.state !== 'locked-by-you' && contextMenu.file.state !== 'locked-by-other'

  const canCheckIn = contextMenu?.file && contextMenu.file.state === 'locked-by-you'

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▴' : ' ▾') : ''

  return (
    <>
      <div className="file-tree-controls">
        <input
          className="tree-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search files, part numbers..."
        />
        {search && (
          <button className="tree-control" onClick={() => setSearch('')}>Clear</button>
        )}
        <span className="file-tree-spacer" />
        <button className="tree-control" onClick={collapseAll} disabled={allFolderPaths.length === 0 || !!search}>
          Collapse all
        </button>
        <button className="tree-control" onClick={expandAll} disabled={collapsed.size === 0 || !!search}>
          Expand all
        </button>
      </div>
      {bulkEnabled && selectedFilePaths.length > 0 && (
        <div className="file-tree-bulk-bar">
          <span className="parts-bulk-count">
            {selectedFilePaths.length} file{selectedFilePaths.length === 1 ? '' : 's'} selected
          </span>
          <select
            value={bulkRelease}
            onChange={e => setBulkRelease(e.target.value as ReleaseState | '')}
            disabled={bulkApplying}
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
            disabled={bulkApplying}
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
            disabled={bulkApplying}
          />
          <button
            className="toolbar-btn primary"
            onClick={applyBulk}
            disabled={bulkApplying || bulkNothingChosen}
          >
            {bulkApplying ? 'Saving…' : `Apply to ${selectedFilePaths.length}`}
          </button>
          <button className="toolbar-btn" onClick={clearBulkSelection} disabled={bulkApplying}>
            Clear
          </button>
        </div>
      )}
      <div className="file-table-header">
        {bulkEnabled && <span className="col-select" />}
        <span className="col-name sortable" onClick={() => setSort('name')}>Name{sortArrow('name')}</span>
        <span className="col-partnum sortable" onClick={() => setSort('partnum')}>Part #{sortArrow('partnum')}</span>
        <span className="col-status sortable" onClick={() => setSort('status')}>Status{sortArrow('status')}</span>
        <span className="col-lock sortable" onClick={() => setSort('lockedby')}>Checked Out By{sortArrow('lockedby')}</span>
      </div>
      <div className="file-table">
        {rows.length === 0 ? (
          <div className="empty-state">
            <p>No files yet</p>
            <p>Add SolidWorks files to your project folder</p>
          </div>
        ) : (
          rows.map(({ entry, depth }) => {
            // Folder rows show indeterminate when SOME (but not all)
            // descendants are checked. Files just track their own bit.
            let checked = bulkSelected.has(entry.path)
            let indeterminate = false
            if (entry.isDirectory) {
              const descs = fileDescendants.get(entry.path) || []
              const checkedKids = descs.filter(d => bulkSelected.has(d)).length
              checked = descs.length > 0 && checkedKids === descs.length
              indeterminate = checkedKids > 0 && checkedKids < descs.length
            }
            return (
              <FileRow
                key={entry.path}
                path={entry.path}
                name={entry.name}
                isDirectory={entry.isDirectory}
                depth={depth}
                selected={selectedPath === entry.path}
                collapsed={collapsed.has(entry.path)}
                state={entry.state}
                partNumber={entry.partNumber}
                releaseState={entry.releaseState}
                commentCount={entry.commentCount}
                lockedBy={entry.lockedBy}
                iconChar={fileIcon(entry)}
                iconTitle={fileIconTitle(entry)}
                dirtyDescendants={entry.isDirectory ? dirtyByFolder.get(entry.path) : undefined}
                showCheckbox={bulkEnabled}
                checked={checked}
                indeterminate={indeterminate}
                onToggleSelect={toggleBulkSelect}
                onClick={handleRowClick}
                onContextMenu={handleRowContext}
              />
            )
          })
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          ref={(el) => {
            if (!el) return
            const rect = el.getBoundingClientRect()
            const clampedX = Math.min(contextMenu.x, window.innerWidth - rect.width - 4)
            const clampedY = Math.min(contextMenu.y, window.innerHeight - rect.height - 4)
            if (parseFloat(el.style.left) !== clampedX) el.style.left = `${clampedX}px`
            if (parseFloat(el.style.top) !== clampedY) el.style.top = `${clampedY}px`
          }}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            disabled={!canCheckOut}
            onClick={() => {
              onCheckOut(contextMenu.file.path)
              setContextMenu(null)
            }}
          >
            Check Out
          </button>
          <button
            className="context-menu-item"
            disabled={!canCheckIn}
            onClick={() => {
              onCheckIn(contextMenu.file.path)
              setContextMenu(null)
            }}
          >
            Check In
          </button>
          <div className="context-menu-separator" />
          <button
            className="context-menu-item"
            onClick={() => {
              window.api.openFileExplorer(contextMenu.file.path)
              setContextMenu(null)
            }}
          >
            Show in Explorer
          </button>
        </div>
      )}
    </>
  )
}
