import { autoUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow } from 'electron'

const RETRY_DELAYS = [30_000, 60_000, 120_000, 240_000]

function isArtifactPending(msg: string): boolean {
  return /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(msg)
    || (/cannot find.*latest.*release/i.test(msg) && !/no published/i.test(msg))
    || /ERR_UPDATER_ASSET_NOT_FOUND/i.test(msg)
}

function isNoRelease(msg: string): boolean {
  return /no published versions/i.test(msg)
    || /ERR_UPDATER_NO_PUBLISHED_VERSIONS/i.test(msg)
    || /enotfound/i.test(msg)
}

function send(win: BrowserWindow | null, channel: string, data?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true
  // Force full-file downloads. The differential (blockmap) downloader is a
  // common cause of a Windows update that "does nothing" — if the previous
  // version's blockmap is unavailable (e.g. after release churn) it can stall
  // instead of cleanly falling back. Full downloads are larger but reliable.
  autoUpdater.disableDifferentialDownload = true

  let retryTimer: ReturnType<typeof setTimeout> | null = null

  // Watchdog for a download that emits neither progress, completion, nor a
  // surfaced error (e.g. a platform that can't self-update, or a stalled
  // network). Without it the banner sits on "downloading…" forever.
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let downloading = false
  const DOWNLOAD_STALL_MS = 90_000

  function cancelStall(): void {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  }
  function armStall(): void {
    cancelStall()
    stallTimer = setTimeout(() => {
      stallTimer = null
      downloading = false
      send(getMainWindow(), 'update-error', {
        message: 'The download didn’t make any progress. This platform or network may not support in-app updates — use Download manually below.'
      })
    }, DOWNLOAD_STALL_MS)
  }

  autoUpdater.on('update-available', (info) => {
    // autoDownload is on, so the download starts right after this fires.
    downloading = true
    armStall()
    send(getMainWindow(), 'update-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    armStall() // progress means the download is alive — extend the watchdog
    send(getMainWindow(), 'update-download-progress', {
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    downloading = false
    cancelStall()
    cancelRetry()
    send(getMainWindow(), 'update-downloaded')
  })

  // Surface DOWNLOAD-phase failures to the UI — previously these were only
  // console.error'd, so the banner stayed stuck on "downloading…". Check-phase
  // errors (no release yet, installer still building, offline) are already
  // handled by checkOnce()'s return value, so only forward once a download has
  // actually started — otherwise those benign cases would show an error.
  autoUpdater.on('error', (err) => {
    const message = (err as Error)?.message || String(err)
    console.error('Auto-update error:', message)
    if (downloading) {
      downloading = false
      cancelStall()
      send(getMainWindow(), 'update-error', { message })
    }
  })

  ipcMain.handle('restart-to-update', () => {
    autoUpdater.quitAndInstall()
  })

  function cancelRetry(): void {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  }

  async function checkOnce(): Promise<{
    success: boolean
    currentVersion?: string
    latestVersion?: string
    updateAvailable?: boolean
    noReleasesYet?: boolean
    error?: string
    artifactPending?: boolean
  }> {
    try {
      const result = await autoUpdater.checkForUpdates()
      const currentVersion = autoUpdater.currentVersion?.version || ''
      const latestVersion = result?.updateInfo?.version || ''
      const updateAvailable = !!latestVersion && latestVersion !== currentVersion
      return { success: true, currentVersion, latestVersion, updateAvailable }
    } catch (err) {
      const msg = (err as Error).message || ''
      if (isArtifactPending(msg)) {
        return {
          success: true,
          currentVersion: autoUpdater.currentVersion?.version || '',
          latestVersion: '',
          updateAvailable: true,
          artifactPending: true
        }
      }
      if (isNoRelease(msg)) {
        return {
          success: true,
          currentVersion: autoUpdater.currentVersion?.version || '',
          latestVersion: '',
          updateAvailable: false,
          noReleasesYet: true
        }
      }
      return { success: false, error: msg }
    }
  }

  function startRetryLoop(attempt: number): void {
    if (attempt >= RETRY_DELAYS.length) {
      send(getMainWindow(), 'update-retry-status', { status: 'gave-up' })
      return
    }
    const delay = RETRY_DELAYS[attempt]
    send(getMainWindow(), 'update-retry-status', {
      status: 'waiting',
      attempt: attempt + 1,
      maxAttempts: RETRY_DELAYS.length,
      nextRetryMs: delay
    })
    retryTimer = setTimeout(async () => {
      retryTimer = null
      send(getMainWindow(), 'update-retry-status', {
        status: 'checking',
        attempt: attempt + 1,
        maxAttempts: RETRY_DELAYS.length
      })
      const r = await checkOnce()
      if (r.artifactPending) {
        startRetryLoop(attempt + 1)
      } else if (r.updateAvailable) {
        send(getMainWindow(), 'update-retry-status', { status: 'found' })
      } else {
        send(getMainWindow(), 'update-retry-status', { status: 'none' })
      }
    }, delay)
  }

  ipcMain.handle('check-for-update', async () => {
    cancelRetry()
    const r = await checkOnce()
    if (r.artifactPending) {
      startRetryLoop(0)
    }
    return r
  })

  ipcMain.handle('cancel-update-retry', () => {
    cancelRetry()
    send(getMainWindow(), 'update-retry-status', { status: 'cancelled' })
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 3000)
}
