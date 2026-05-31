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
  const promise = new Promise<string | null>(resolve => {
    const run = (): void => {
      thumbActive++
      window.api.getThumbnail(path, size)
        .then(dataUrl => { rendererCache.set(key, dataUrl); return dataUrl })
        .catch(() => { rendererCache.set(key, null); return null })
        .then(result => {
          thumbActive--
          pumpThumbQueue()
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

/** Drop the renderer-side cache, e.g. when the project closes. */
export function clearRendererThumbnailCache(): void {
  rendererCache.clear()
}
