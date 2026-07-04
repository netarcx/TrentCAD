import { useEffect, useState, type ReactNode } from 'react'

/**
 * Module-level cache mirroring the main-process thumbnail cache. Prevents
 * duplicate IPC calls when the same path appears in multiple FileRow
 * instances within a single React tree. Keyed by `<size>:<path>`.
 *
 * Each value is either `string` (data URL), `null` (resolved as no
 * thumbnail available), or `Promise<...>` (in flight — co-located so
 * concurrent renders await the same promise instead of firing N
 * duplicate IPCs).
 */
const rendererCache = new Map<string, string | null | Promise<string | null>>()

// Bumped every time the cache is cleared (project close/switch). Thumbnail keys
// are `<size>:<PROJECT-RELATIVE-path>`, and the same relative path exists in
// different projects — so a fetch started in project A that resolves after a
// switch to B would otherwise cache A's image under a key B also uses (B shows
// A's thumbnail), and a queued fetch that runs while no project is open resolves
// to null and poisons the key permanently. A fetch captures the generation it
// began in and refuses to write the cache once that generation is stale.
let cacheGeneration = 0

// Cap concurrent getThumbnail IPC calls. Opening a 500+ file project mounts
// that many FileThumbnail rows at once; firing every getThumbnail immediately
// floods the IPC channel so status/sync/ping responses queue behind the
// backlog and the window appears frozen for a burst. We run at most N at a
// time and queue the rest locally — thumbnails still all load, just paced.
const THUMB_MAX_CONCURRENT = 8
let thumbActive = 0
const thumbQueue: (() => void)[] = []

function pumpThumbQueue(): void {
  while (thumbActive < THUMB_MAX_CONCURRENT && thumbQueue.length > 0) {
    const next = thumbQueue.shift()!
    next()
  }
}

function fetchThumbnail(path: string, size: number): Promise<string | null> {
  const key = `${size}:${path}`
  const cached = rendererCache.get(key)
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached
    return Promise.resolve(cached)
  }
  // Each unique key enters the queue exactly once; duplicate mounts await the
  // same promise via the cache check above.
  const gen = cacheGeneration
  const promise = new Promise<string | null>(resolve => {
    const run = (): void => {
      // Cache was cleared (project switched) before this got a slot — don't run
      // it against the new project; resolve as "no thumbnail" without caching.
      if (gen !== cacheGeneration) { resolve(null); return }
      thumbActive++
      window.api.getThumbnail(path, size)
        .then(dataUrl => dataUrl, () => null)
        .then(result => {
          thumbActive--
          pumpThumbQueue()
          // Only write the cache if we're still in the SAME generation — a
          // resolution landing after a clear belongs to the old project and
          // would poison the fresh cache under a colliding relative-path key.
          if (gen === cacheGeneration) rendererCache.set(key, result)
          resolve(result)
        })
    }
    thumbQueue.push(run)
    pumpThumbQueue()
  })
  rendererCache.set(key, promise)
  return promise
}

interface Props {
  path: string
  size: number
  /** Rendered while the thumbnail is loading or unavailable. Should be
   *  the cheap letter-icon style placeholder so the file table stays
   *  stable while async thumbnails resolve. */
  fallback: ReactNode
  className?: string
  title?: string
}

export default function FileThumbnail({ path, size, fallback, className, title }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchThumbnail(path, size).then(url => {
      if (!cancelled) setDataUrl(url)
    })
    return () => { cancelled = true }
  }, [path, size])

  if (dataUrl) {
    return (
      <img
        className={className}
        src={dataUrl}
        alt=""
        width={size}
        height={size}
        title={title}
        draggable={false}
      />
    )
  }
  return <>{fallback}</>
}

/** Drop the renderer-side cache, e.g. when the project closes. Also invalidates
 *  the generation so any in-flight/queued fetch from the old project can't write
 *  back into the fresh cache, and drains the pending queue. */
export function clearRendererThumbnailCache(): void {
  cacheGeneration++
  rendererCache.clear()
  thumbQueue.length = 0
}
