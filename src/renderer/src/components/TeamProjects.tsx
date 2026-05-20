import { useState } from 'react'
import type { ProjectEntry } from '@shared/types'

interface Props {
  projects: ProjectEntry[]
  onPick: (url: string, suggestedName: string) => void
  onClose: () => void
}

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return d.toLocaleDateString()
}

export default function TeamProjects({ projects, onPick, onClose }: Props) {
  const [filter, setFilter] = useState('')

  const visible = projects.filter(p => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
  })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal browse-modal" onClick={e => e.stopPropagation()}>
        <h2>Team Projects</h2>
        <p className="admin-hint">
          Projects registered in the team coordination repo.
          Click <em>Join</em> to clone one locally.
        </p>

        <input
          className="browse-filter"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by name or description..."
        />

        {visible.length === 0 && (
          <div className="browse-empty">
            {projects.length === 0
              ? 'No projects registered yet — an admin can add projects from the Admin Panel'
              : 'No projects match your filter'}
          </div>
        )}

        {visible.length > 0 && (
          <div className="browse-list">
            {visible.map(p => (
              <div className="browse-item" key={p.repoUrl}>
                <div className="browse-item-main">
                  <div className="browse-item-name">{p.name}</div>
                  {p.description && <div className="browse-item-desc">{p.description}</div>}
                  <div className="browse-item-meta">
                    {p.repoUrl.replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, '')}
                    {p.createdAt && <> · added {relativeTime(p.createdAt)}</>}
                  </div>
                </div>
                <button
                  className="toolbar-btn primary"
                  onClick={() => onPick(p.repoUrl, p.name)}
                >
                  Join
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="actions">
          <button className="toolbar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
