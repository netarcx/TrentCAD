import { useEffect, useState } from 'react'
import { api } from '../api'

interface OutdatedClient {
  deviceId: number
  deviceLabel: string
  clientVersion: string | null
  memberId: number
  displayName: string
  role: string
}

interface VersionStatus {
  server: {
    current: string
    latest: string | null
    outdated: boolean
  }
  clients: {
    latest: string | null
    total: number
    outdated: OutdatedClient[]
  }
}

/**
 * Yellow banner that warns the admin when either the team server
 * itself or any enrolled desktop is running an older version than the
 * latest GitHub release. Silent (renders nothing) when everything is
 * current OR when the GitHub check failed — we never nag the admin
 * about a state we couldn't confirm.
 */
export default function UpdateBanner() {
  const [status, setStatus] = useState<VersionStatus | null>(null)

  useEffect(() => {
    api<VersionStatus>('GET', '/api/admin/version-status').then(setStatus).catch(() => {})
  }, [])

  if (!status) return null
  const serverBehind = status.server.outdated && status.server.latest
  const clientsBehind = status.clients.outdated.length > 0
  if (!serverBehind && !clientsBehind) return null

  const releasesUrl = 'https://github.com/netarcx/framecad/releases/latest'

  return (
    <div className="update-banner">
      <div className="ub-icon">⚠</div>
      <div className="ub-body">
        <strong>Update available</strong>
        {serverBehind && (
          <div style={{ marginTop: 4 }}>
            Team server is running <span className="mono">v{status.server.current}</span>;
            latest is <span className="mono">v{status.server.latest}</span>.{' '}
            <a href={releasesUrl} target="_blank" rel="noopener noreferrer">
              Release notes
            </a>
          </div>
        )}
        {clientsBehind && (
          <div style={{ marginTop: 6 }}>
            {status.clients.outdated.length} desktop
            {status.clients.outdated.length === 1 ? '' : 's'} behind{' '}
            <span className="mono">v{status.clients.latest}</span>:
            <ul>
              {status.clients.outdated.slice(0, 8).map(c => (
                <li key={c.deviceId}>
                  <strong>{c.displayName}</strong>
                  {' '}({c.deviceLabel}) — <span className="mono">v{c.clientVersion}</span>
                </li>
              ))}
              {status.clients.outdated.length > 8 && (
                <li>…and {status.clients.outdated.length - 8} more</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
