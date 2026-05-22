/**
 * Minimal Docker log reader.
 *
 * Hits the local Docker engine's Unix socket at /var/run/docker.sock
 * (bind-mounted into our container via docker-compose), reads logs
 * from a container by name, and parses Docker's multiplexed frame
 * format into clean text lines. Designed for snapshot reads (most
 * recent N lines) used by the admin UI's Logs page — NOT for
 * long-lived streaming, which would warrant a proper SSE layer.
 *
 * The framed format (from Docker Engine API v1.43):
 *   - 8-byte header per chunk:
 *       byte 0: stream type (1=stdout, 2=stderr)
 *       bytes 1-3: padding (zeros)
 *       bytes 4-7: payload size (uint32 big-endian)
 *   - N bytes payload (raw bytes, may include partial lines)
 *
 * When the container was started with tty=true, the format is raw
 * with no framing — we treat that as a fallback and just decode the
 * whole buffer as UTF-8.
 */

import * as http from 'node:http'

const SOCKET_PATH = '/var/run/docker.sock'

export interface DockerLogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

/**
 * Fetch the last `tail` lines of a container's logs by container name.
 * Resolves with parsed lines (stream tag + text). Rejects when the
 * socket isn't reachable, the container doesn't exist, or the
 * response can't be parsed.
 */
export async function fetchContainerLogs(
  containerName: string,
  tail = 200,
): Promise<DockerLogLine[]> {
  // Container lookup-by-name in the Docker API supports a leading slash.
  const opts: http.RequestOptions = {
    socketPath: SOCKET_PATH,
    method: 'GET',
    path:
      `/containers/${encodeURIComponent(containerName)}/logs` +
      `?stdout=1&stderr=1&tail=${Math.max(1, Math.min(10000, Math.floor(tail)))}` +
      `&timestamps=1&follow=0`,
  }
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const req = http.request(opts, res => {
      if (res.statusCode !== 200) {
        // Drain the body so the socket doesn't hang half-read, then
        // reject with a useful message.
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          reject(new Error(`Docker logs HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
        })
        res.on('error', reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', err => {
      // Common cases: socket not mounted (ENOENT), permission denied,
      // engine not running. Surface as a single readable message.
      reject(new Error(`Docker socket unreachable: ${(err as Error).message}`))
    })
    // 5s ceiling — these reads should be near-instant.
    req.setTimeout(5000, () => {
      req.destroy(new Error('Docker logs request timed out (5s)'))
    })
    req.end()
  })

  return parseFramedLogs(buf)
}

/**
 * Walk Docker's frame-prefixed log buffer. Falls back to a plain
 * UTF-8 decode if the first byte doesn't look like a valid frame
 * header (which happens when the container was started with tty=1).
 */
export function parseFramedLogs(buf: Buffer): DockerLogLine[] {
  const lines: DockerLogLine[] = []
  let offset = 0
  // Sentinel: real frames start with 0 or 1 or 2 in byte 0 and the
  // next 3 bytes are zero padding. If that's not the case, treat the
  // buffer as raw text (tty mode).
  const looksFramed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
  if (!looksFramed) {
    for (const text of buf.toString('utf-8').split('\n')) {
      if (text.length) lines.push({ stream: 'stdout', text })
    }
    return lines
  }
  // Buffer one partial line per stream while we walk frames — a
  // single output line can span multiple frames if Docker chunks it.
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]
    const size = buf.readUInt32BE(offset + 4)
    offset += 8
    if (offset + size > buf.length) break
    const payload = buf.slice(offset, offset + size).toString('utf-8')
    offset += size
    const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout'
    const combined = partial[stream] + payload
    const segments = combined.split('\n')
    // Last segment may be partial (no terminating \n yet) — stash
    // it back for the next frame.
    partial[stream] = segments.pop() ?? ''
    for (const text of segments) {
      lines.push({ stream, text })
    }
  }
  // Flush any leftover partial lines so the caller doesn't lose the
  // last (unterminated) line that was being printed when we read.
  for (const stream of ['stdout', 'stderr'] as const) {
    if (partial[stream]) lines.push({ stream, text: partial[stream] })
  }
  return lines
}
