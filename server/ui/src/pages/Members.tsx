import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import CapabilityControls from '../components/CapabilityControls'
import {
  EMPTY_CAPABILITY_VALUE,
  capCount,
  type CapabilityValue,
  type MemberCapabilities,
  type ProjectOption,
} from '../caps'

interface Member {
  id: number
  displayName: string
  githubUsername: string | null
  role: 'admin' | 'mentor' | 'student'
  joinedAt: number
  capabilities?: MemberCapabilities
  allowedProjectIds?: number[]
  autoOpenProjectId?: number | null
}

/** /api/members only returns the lean shape (no caps). For the admin
 *  UI we fetch from a dedicated admin endpoint that includes them. */
interface MemberFull extends Member {
  capabilities: MemberCapabilities
  allowedProjectIds: number[]
  autoOpenProjectId: number | null
}

export default function Members() {
  const [members, setMembers] = useState<MemberFull[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)

  async function load(): Promise<void> {
    try {
      const [membersRes, projectsRes] = await Promise.all([
        api<{ members: MemberFull[] }>('GET', '/api/admin/members'),
        api<{ projects: ProjectOption[] }>('GET', '/api/projects'),
      ])
      // Defensive: the /api/admin/members endpoint may not exist on
      // older servers — fall back to /api/members which doesn't carry
      // caps, then merge in EMPTY for each row.
      setMembers(
        membersRes.members.map(m => ({
          ...m,
          capabilities: m.capabilities ?? EMPTY_CAPABILITY_VALUE.capabilities,
          allowedProjectIds: m.allowedProjectIds ?? [],
          autoOpenProjectId: m.autoOpenProjectId ?? null,
        })),
      )
      setProjects(projectsRes.projects)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  useEffect(() => { load() }, [])

  async function patch(id: number, body: Record<string, unknown>): Promise<void> {
    setSavingId(id)
    setError(null)
    try {
      await api('PATCH', `/api/admin/members/${id}`, body)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSavingId(null)
    }
  }

  async function remove(m: MemberFull): Promise<void> {
    if (!confirm(`Remove ${m.displayName} from the team? This revokes all their devices.`)) return
    setSavingId(m.id)
    setError(null)
    try {
      await api('DELETE', `/api/admin/members/${m.id}`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSavingId(null)
    }
  }

  async function saveCaps(m: MemberFull, next: CapabilityValue): Promise<void> {
    await patch(m.id, {
      capabilities: next.capabilities,
      allowedProjectIds: next.allowedProjectIds,
      autoOpenProjectId: next.autoOpenProjectId,
    })
    setEditingId(null)
  }

  return (
    <>
      <h1>Members</h1>
      <div className="sub">{members.length} member{members.length === 1 ? '' : 's'}</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Roster</h3>
        <div className="hint">
          Change a role to promote / demote a member. Edit caps to control
          which home-screen buttons they see in FrameCAD.
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>GitHub</th>
              <th>Role</th>
              <th>Caps</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <>
                <tr key={m.id}>
                  <td>{m.displayName}</td>
                  <td className="mono">{m.githubUsername ? '@' + m.githubUsername : '—'}</td>
                  <td>
                    <select
                      value={m.role}
                      disabled={savingId === m.id}
                      onChange={e => patch(m.id, { role: e.target.value })}
                    >
                      <option value="admin">Admin</option>
                      <option value="mentor">Mentor</option>
                      <option value="student">Student</option>
                    </select>
                  </td>
                  <td className="mono">
                    {capCount(m.capabilities)}/4
                    {m.allowedProjectIds.length > 0 && (
                      <span className="hint" style={{ marginLeft: 6 }}>
                        ({m.allowedProjectIds.length} proj)
                      </span>
                    )}
                  </td>
                  <td className="mono">{new Date(m.joinedAt).toLocaleDateString()}</td>
                  <td className="row-actions">
                    <button
                      className="secondary"
                      disabled={savingId === m.id}
                      onClick={() => setEditingId(editingId === m.id ? null : m.id)}
                    >
                      {editingId === m.id ? 'Cancel' : 'Edit caps'}
                    </button>
                    <button className="secondary danger" disabled={savingId === m.id} onClick={() => remove(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
                {editingId === m.id && (
                  <tr key={`${m.id}-edit`}>
                    <td colSpan={6} style={{ background: 'rgba(255,255,255,0.04)' }}>
                      <MemberCapsEditor
                        member={m}
                        projects={projects}
                        disabled={savingId === m.id}
                        onSave={next => saveCaps(m, next)}
                        onCancel={() => setEditingId(null)}
                      />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** Inline editor for a single member's caps. Local draft state so the
 *  admin can tick / untick without firing N PATCHes; commits on Save. */
function MemberCapsEditor(props: {
  member: MemberFull
  projects: ProjectOption[]
  disabled?: boolean
  onSave: (next: CapabilityValue) => void
  onCancel: () => void
}) {
  const { member, projects, disabled, onSave, onCancel } = props
  const [draft, setDraft] = useState<CapabilityValue>({
    capabilities: member.capabilities,
    allowedProjectIds: member.allowedProjectIds,
    autoOpenProjectId: member.autoOpenProjectId,
  })
  return (
    <div style={{ padding: '12px 4px' }}>
      <CapabilityControls
        value={draft}
        onChange={setDraft}
        projects={projects}
        disabled={disabled}
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="primary" disabled={disabled} onClick={() => onSave(draft)}>
          Save caps
        </button>
        <button className="secondary" disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
