import { useEffect, useState } from 'react'
import { api } from '../api'
import UpdateBanner from '../components/UpdateBanner'

interface Team { name: string; gitHubOrg: string; projectPrefix: string; welcomeMessage: string }
interface Member { id: number; displayName: string; role: string }
interface Project { id: number; name: string; repoUrl: string }
interface Device { id: number; label: string; lastSeenAt: number; displayName: string; role: string }

function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

export default function Dashboard() {
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [devices, setDevices] = useState<Device[]>([])

  useEffect(() => {
    api<Team>('GET', '/api/team').then(setTeam).catch(() => {})
    api<{ members: Member[] }>('GET', '/api/members').then(r => setMembers(r.members)).catch(() => {})
    api<{ projects: Project[] }>('GET', '/api/projects').then(r => setProjects(r.projects)).catch(() => {})
    api<{ devices: Device[] }>('GET', '/api/admin/devices').then(r => setDevices(r.devices)).catch(() => {})
  }, [])

  return (
    <>
      <UpdateBanner />
      <h1>{team?.name ?? 'Loading…'}</h1>
      <div className="sub">
        {team?.gitHubOrg
          ? `GitHub: ${team.gitHubOrg}${team.projectPrefix ? ` · prefix ${team.projectPrefix}` : ''}`
          : 'Configure your team in Settings to get started.'}
      </div>

      <div className="card">
        <h3>At a glance</h3>
        <table>
          <tbody>
            <tr><td>Members</td><td className="mono">{members.length}</td></tr>
            <tr><td>Active projects</td><td className="mono">{projects.length}</td></tr>
            <tr><td>Enrolled devices</td><td className="mono">{devices.length}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Recently active devices</h3>
        {devices.length === 0 ? (
          <div className="hint">No devices enrolled yet.</div>
        ) : (
          <table>
            <thead><tr><th>Device</th><th>Member</th><th>Role</th><th>Last seen</th></tr></thead>
            <tbody>
              {devices.slice(0, 6).map(d => (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td>{d.displayName}</td>
                  <td><span className={`pill ${d.role}`}>{d.role}</span></td>
                  <td className="mono">{relTime(d.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
