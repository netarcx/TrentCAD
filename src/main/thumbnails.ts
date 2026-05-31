import { nativeImage } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { getProjectPath } from './project-paths'

/**
 * In-memory thumbnail cache keyed by `<size>:<absPath>:<mtimeMs>`. The
 * mtime suffix invalidates stale thumbnails when a file is edited in
 * SolidWorks (the OS thumbnail provider also picks up the change, so
 * we just need to ask for it again). The whole map sits in main-process
 * memory and clears on app restart — cheap and good-enough for the
 * shop-floor workflow.
 */
const cache = new Map<string, string | null>()

const SUPPORTED_EXTS = new Set([
  '.sldprt', '.sldasm', '.slddrw',
  '.step', '.stp',
  '.stl',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp'
])

export async function getThumbnail(filePath: string, size: number): Promise<string | null> {
  // filePath is project-relative; resolve it against the open project.
  let absPath: string
  try {
    absPath = path.join(getProjectPath(), filePath)
  } catch {
    return null
  }

  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) return null

  let mtimeMs: number
  try {
    const st = await fs.stat(absPath)
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }

  const cacheKey = `${size}:${absPath}:${mtimeMs}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  try {
    // createThumbnailFromPath asks the OS shell for the file's preview.
    // On Windows this hits the SolidWorks thumbnail provider and gives
    // a real model preview; on macOS QuickLook does the equivalent for
    // PDF / STL. Unsupported types yield an empty image, which we
    // treat as "no thumbnail" and let the renderer fall back to a
    // letter icon.
    const img = await nativeImage.createThumbnailFromPath(absPath, { width: size, height: size })
    if (img.isEmpty()) {
      cache.set(cacheKey, null)
      return null
    }
    const dataUrl = img.toDataURL()
    cache.set(cacheKey, dataUrl)
    return dataUrl
  } catch {
    cache.set(cacheKey, null)
    return null
  }
}

/** Drop the entire thumbnail cache. Called when a project closes. */
export function clearThumbnailCache(): void {
  cache.clear()
}
