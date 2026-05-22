import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'

interface LogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

interface LogResponse {
  container: string
  tail: number
  lines: LogLine[]
}

const CONTAINERS = [
  { id: 'framecad-server', label: 'Team server (Node)' },
  { id: 'framecad-lfs', label: 'LFS server (Giftless)' },
] as const

type ContainerId = typeof CONTAINERS[number]['id']

/**
 * Admin-only viewer for the two framecad containers' stdout/stderr.
 *
 * Snapshot-based — hits `/api/admin/logs/:name` every few seconds
 * (or on a Refresh click) and renders the last N lines. Deliberately
 * not a live SSE stream: snapshot polling is much simpler to keep
 * reliable across reverse proxies + browser tab sleeps, and a debug
 * page rarely needs sub-second latency. The 5-second auto-refresh
 * cadence is enough to watch a publish or quota scan progress while
 * not hammering the Docker socket.
 *
 * Errors that come back from the server (Docker socket not mounted,
 * container not running, etc.) are rendered inline so the admin
 * doesn't have to drop into SSH to diagnose.
 */
export default function Logs() {
  const [active, setActive] = useState<ContainerId>('framecad-server')
  const [tail, setTail] = useState(500)
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true)
  // Scroll the log view to the bottom on new data unless the user
  // has scrolled up — once they look at older lines, we shouldn't
  // yank them back to the tail on every refresh.
  const scrollRef = useRef<HTMLPreElement | null>(null)
  const stickToBottomRef = useRef(true)

  async function refresh(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api<LogResponse>('GET', `/api/admin/logs/${active}?tail=${tail}`)
      setLines(res.lines)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  // Auto-refresh + container switch.
  useEffect(() => {
    refresh()
    if (!auto) return
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tail, auto])

  // Stick-to-bottom behaviour. Whenever `lines` changes AND the user
  // hasn't scrolled away from the bottom, scroll to the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  function onScroll(e: React.UIEvent<HTMLPreElement>): void {
    const el = e.currentTarget
    // 12px slack so a tiny rubber-band on macOS doesn't break stickiness.
    stickToBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 12
  }

  return (
    <>
      <h1>Logs</h1>
      <div className="sub">Live tail of the docker-compose stack's containers.</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {CONTAINERS.map(c => (
            <button
              key={c.id}
              className={c.id === active ? 'primary' : 'secondary'}
              onClick={() => setActive(c.id)}
            >
              {c.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            <span>Last</span>
            <select value={tail} onChange={e => setTail(Number.parseInt(e.target.value, 10))}>
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="2000">2000</option>
            </select>
            <span>lines</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
            Auto-refresh
          </label>
          <button className="secondary" onClick={refresh} disabled={busy}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <pre
          ref={scrollRef}
          onScroll={onScroll}
          className="mono"
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 12,
            lineHeight: 1.4,
            maxHeight: '70vh',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {lines.length === 0
            ? (busy ? 'Loading…' : 'No log lines yet. Refresh, or wait for the container to write something.')
            : lines.map((line, i) => (
                <span
                  key={i}
                  style={{
                    display: 'block',
                    color: line.stream === 'stderr' ? 'var(--red)' : undefined,
                  }}
                >
                  {line.text || ' '}
                </span>
              ))}
        </pre>
      </div>
    </>
  )
}
