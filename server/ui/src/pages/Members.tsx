import { Fragment, useEffect, useState } from 'react'
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
  kioskMode?: boolean
  archiveMode?: boolean
}

/** /api/members only returns the lean shape (no caps). For the admin
 *  UI we fetch from a dedicated admin endpoint that includes them. */
interface MemberFull extends Member {
  capabilities: MemberCapabilities
  allowedProjectIds: number[]
  autoOpenProjectId: number | null
  kioskMode: boolean
  archiveMode: boolean
}

export default function Members() {
  const [members, setMembers] = useState<MemberFull[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  /** Freshly issued re-enroll PIN per member id, shown inline until dismissed. */
  const [issuedPins, setIssuedPins] = useState<Record<number, string>>({})
  const [copiedPin, setCopiedPin] = useState<string | null>(null)

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
          kioskMode: !!m.kioskMode,
          archiveMode: !!m.archiveMode,
        })),
      )
      setProjects(projectsRes.projects)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  useEffect(() => { load() }, [])

  /** PATCH a member. Returns true on success so callers (saveCaps) can
   *  keep their editor open — draft intact — when the server rejects. */
  async function patch(id: number, body: Record<string, unknown>): Promise<boolean> {
    setSavingId(id)
    setError(null)
    try {
      await api('PATCH', `/api/admin/members/${id}`, body)
      await load()
      return true
    } catch (err) {
      setError((err as ApiError).message)
      return false
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

  /** Issue a re-enrollment PIN bound to this member — for a new laptop or a
   *  wiped install. Enrolling with it attaches the device to the SAME member
   *  (role/caps/allowlist intact) instead of creating a duplicate. */
  async function issueMemberPin(m: MemberFull): Promise<void> {
    setSavingId(m.id)
    setError(null)
    try {
      const pin = await api<{ code: string }>('POST', `/api/admin/members/${m.id}/pin`)
      setIssuedPins(prev => ({ ...prev, [m.id]: pin.code }))
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setSavingId(null)
    }
  }

  async function saveCaps(m: MemberFull, next: CapabilityValue): Promise<void> {
    const ok = await patch(m.id, {
      capabilities: next.capabilities,
      allowedProjectIds: next.allowedProjectIds,
      autoOpenProjectId: next.autoOpenProjectId,
      kioskMode: next.kioskMode,
      archiveMode: next.archiveMode,
    })
    // Only collapse the editor on success — a failed save keeps the
    // draft on screen so the admin can fix it and retry.
    if (ok) setEditingId(null)
  }

  return (
    <>
      <h1>Members</h1>
      <div className="sub">{members.length} member{members.length === 1 ? '' : 's'}</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Roster</h3>
        <div className="hint">
          Change a role to promote / demote a member. Set permissions to
          control which home-screen buttons they see in FrameCAD.
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
              // `Fragment` (not the `<>` shorthand) so we can put the
              // React key on the iteration root. The shorthand can't
              // take a key, which used to leave both rows keyed only
              // on their own internal id and confused reconciliation
              // when members were added/removed/reordered.
              <Fragment key={m.id}>
                <tr>
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
                    {capCount(m.capabilities)} caps
                    {m.allowedProjectIds.length > 0 && (
                      <span className="hint" style={{ marginLeft: 6 }}>
                        ({m.allowedProjectIds.length} proj)
                      </span>
                    )}
                    {m.kioskMode && (
                      <span
                        className="pill"
                        style={{ marginLeft: 6, color: 'var(--accent)', background: 'var(--accent-tint)' }}
                        title="Kiosk mode — desktop locked to the auto-open project"
                      >
                        KIOSK
                      </span>
                    )}
                    {m.archiveMode && (
                      <span
                        className="pill"
                        style={{ marginLeft: 6, color: 'var(--accent)', background: 'var(--accent-tint)' }}
                        title="Archive device — read-only mirror that auto-downloads and never uploads"
                      >
                        ARCHIVE
                      </span>
                    )}
                  </td>
                  <td className="mono">{new Date(m.joinedAt).toLocaleDateString()}</td>
                  <td className="row-actions">
                    <button
                      className="secondary"
                      disabled={savingId === m.id}
                      title="Issue a PIN that re-enrolls this member on another device — same account, role, and permissions"
                      onClick={() => issueMemberPin(m)}
                    >
                      New PIN
                    </button>
                    <button
                      className="secondary"
                      disabled={savingId === m.id}
                      onClick={() => setEditingId(editingId === m.id ? null : m.id)}
                    >
                      {editingId === m.id ? 'Cancel' : 'Set Permissions'}
                    </button>
                    <button className="secondary danger" disabled={savingId === m.id} onClick={() => remove(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
                {issuedPins[m.id] && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--accent-tint)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px', flexWrap: 'wrap' }}>
                        <span className="hint">
                          Enrollment PIN for <strong>{m.displayName}</strong> — single-use, expires in 7 days.
                          It signs the new device into this account:
                        </span>
                        <span className="mono" style={{ fontSize: 16, fontWeight: 700, letterSpacing: 2 }}>
                          {issuedPins[m.id]}
                        </span>
                        <button
                          className="secondary"
                          onClick={() => {
                            navigator.clipboard.writeText(issuedPins[m.id]).then(() => {
                              setCopiedPin(issuedPins[m.id])
                              setTimeout(() => setCopiedPin(null), 1500)
                            })
                          }}
                        >
                          {copiedPin === issuedPins[m.id] ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                          className="secondary"
                          onClick={() => setIssuedPins(prev => {
                            const next = { ...prev }
                            delete next[m.id]
                            return next
                          })}
                        >
                          Dismiss
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                {editingId === m.id && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg-hover)' }}>
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
              </Fragment>
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
    kioskMode: member.kioskMode,
    archiveMode: member.archiveMode,
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
