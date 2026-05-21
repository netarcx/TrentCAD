import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface Member {
  id: number
  displayName: string
  githubUsername: string | null
  role: 'admin' | 'mentor' | 'student'
  joinedAt: number
}

export default function Members() {
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)

  async function load(): Promise<void> {
    try {
      const res = await api<{ members: Member[] }>('GET', '/api/members')
      setMembers(res.members)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  useEffect(() => { load() }, [])

  async function patch(id: number, body: Partial<Member>): Promise<void> {
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

  async function remove(m: Member): Promise<void> {
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

  return (
    <>
      <h1>Members</h1>
      <div className="sub">{members.length} member{members.length === 1 ? '' : 's'}</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Roster</h3>
        <div className="hint">
          Change a role to promote / demote a member. New members join by
          consuming an enrollment PIN you generate on the Enrollment page.
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>GitHub</th>
              <th>Role</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.displayName}</td>
                <td className="mono">{m.githubUsername ? '@' + m.githubUsername : '—'}</td>
                <td>
                  <select
                    value={m.role}
                    disabled={savingId === m.id}
                    onChange={e => patch(m.id, { role: e.target.value as Member['role'] })}
                  >
                    <option value="admin">Admin</option>
                    <option value="mentor">Mentor</option>
                    <option value="student">Student</option>
                  </select>
                </td>
                <td className="mono">{new Date(m.joinedAt).toLocaleDateString()}</td>
                <td className="row-actions">
                  <button className="secondary danger" disabled={savingId === m.id} onClick={() => remove(m)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
