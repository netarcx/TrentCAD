import fs from 'fs/promises'
import path from 'path'
import type { SimpleGit } from 'simple-git'

// Cloudflare Free/Pro tunnels hard-cap request bodies at 100 MB.
// Pre-upload anything above this threshold via Giftless's multipart-
// basic protocol so each part stays well under the wire.
const CF_BODY_CAP = 95 * 1024 * 1024

const PART_CONCURRENCY = 8

interface LfsPointer {
  oid: string
  size: number
}

interface PartAction {
  href: string
  pos: number
  size: number
  expires_in: number
  header?: Record<string, string>
}

interface ActionEndpoint {
  href: string
  method?: string
  expires_in: number
  header?: Record<string, string>
}

interface BatchResponse {
  transfer: string
  objects: Array<{
    oid: string
    size: number
    actions?: {
      parts?: PartAction[]
      commit?: ActionEndpoint
      abort?: ActionEndpoint
    }
    error?: { code: number; message: string }
  }>
}

function parseLfsPointer(content: string): LfsPointer | null {
  if (!content.includes('https://git-lfs.github.com/spec/v1')) return null
  const oid = content.match(/oid sha256:([0-9a-f]{64})/)
  const size = content.match(/size (\d+)/)
  if (!oid || !size) return null
  return { oid: oid[1], size: parseInt(size[1], 10) }
}

function lfsObjectPath(projectDir: string, oid: string): string {
  return path.join(
    projectDir, '.git', 'lfs', 'objects',
    oid.slice(0, 2), oid.slice(2, 4), oid,
  )
}

async function uploadPart(
  href: string,
  headers: Record<string, string>,
  objectPath: string,
  pos: number,
  size: number,
): Promise<void> {
  const fd = await fs.open(objectPath, 'r')
  try {
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fd.read(buf, 0, size, pos)
    const body = bytesRead === size ? buf : buf.subarray(0, bytesRead)
    const res = await fetch(href, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`part upload ${res.status}: ${text}`)
    }
  } finally {
    await fd.close()
  }
}

/**
 * Pre-upload LFS objects that exceed Cloudflare's body-size cap via
 * Giftless's multipart-basic protocol. Call between `git commit` and
 * `git push` — when git-lfs fires its pre-push hook, these objects
 * already exist on the server and the batch response says "skip".
 *
 * Returns the number of objects successfully pre-uploaded. Zero when
 * there's nothing over the cap or the server doesn't support
 * multipart-basic (caller falls through to the normal push path).
 */
export async function preUploadLargeObjects(opts: {
  projectDir: string
  files: string[]
  endpoint: string
  token: string
  onProgress?: (detail: string, percent?: number) => void
  git: SimpleGit
}): Promise<number> {
  const { projectDir, files, endpoint, token, onProgress, git } = opts

  const large: Array<{
    oid: string; size: number; objectPath: string; name: string
  }> = []

  for (const file of files) {
    try {
      const content = await git.show([`HEAD:${file}`])
      const ptr = parseLfsPointer(content)
      if (!ptr || ptr.size <= CF_BODY_CAP) continue
      const objPath = lfsObjectPath(projectDir, ptr.oid)
      await fs.access(objPath)
      large.push({
        oid: ptr.oid,
        size: ptr.size,
        objectPath: objPath,
        name: path.basename(file),
      })
    } catch { continue }
  }

  if (large.length === 0) return 0

  const sizeMB = Math.round(CF_BODY_CAP / 1024 / 1024)
  onProgress?.(
    `${large.length} file${large.length === 1 ? '' : 's'} over ${sizeMB} MB — uploading via multipart`,
  )

  const batchRes = await fetch(`${endpoint}/objects/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.git-lfs+json',
      Accept: 'application/vnd.git-lfs+json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operation: 'upload',
      transfers: ['multipart-basic', 'basic'],
      objects: large.map(o => ({ oid: o.oid, size: o.size })),
      hash_algo: 'sha256',
    }),
  })
  if (!batchRes.ok) {
    const text = await batchRes.text().catch(() => '')
    throw new Error(`multipart batch ${batchRes.status}: ${text}`)
  }
  const batch: BatchResponse = await batchRes.json()

  // The batch response MAY include a top-level `transfer` field
  // indicating which protocol was negotiated. If the server chose
  // basic (no multipart), we can't pre-upload — return and let the
  // normal push path handle it. Also bail if there are no parts on
  // ANY object (server doesn't support real multipart actions).
  const hasMultipart = batch.transfer === 'multipart-basic'
    || batch.objects.some(o => o.actions?.parts)
  if (!hasMultipart) return 0

  let uploaded = 0

  for (const obj of batch.objects) {
    if (obj.error) {
      throw new Error(
        `LFS error for ${obj.oid.slice(0, 12)}: ${obj.error.message}`,
      )
    }
    if (!obj.actions?.parts) continue

    const local = large.find(o => o.oid === obj.oid)
    if (!local) continue

    const parts = obj.actions.parts
    const total = parts.length
    let done = 0

    for (let i = 0; i < parts.length; i += PART_CONCURRENCY) {
      const slice = parts.slice(i, i + PART_CONCURRENCY)
      await Promise.all(
        slice.map(async part => {
          await uploadPart(
            part.href,
            part.header ?? {},
            local.objectPath,
            part.pos,
            part.size,
          )
          done++
          onProgress?.(
            `${local.name}: part ${done}/${total}`,
            Math.round((done / total) * 100),
          )
        }),
      )
    }

    const commit = obj.actions.commit
    if (commit) {
      const res = await fetch(commit.href, {
        method: commit.method ?? 'POST',
        headers: commit.header ?? {},
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(
          `multipart commit failed for ${local.name}: ${res.status} ${text}`,
        )
      }
    }

    onProgress?.(`${local.name}: upload complete`)
    uploaded++
  }

  return uploaded
}
