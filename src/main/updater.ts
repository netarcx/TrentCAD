import { autoUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow } from 'electron'

const RETRY_DELAYS = [30_000, 60_000, 120_000, 240_000]

function isArtifactMissing(msg: string): boolean {
  return /404|not found|cannot find|ENOENT|no published/i.test(msg)
    && !/latest.*yml/i.test(msg)
}

function isNoRelease(msg: string): boolean {
  return /404|not found|cannot find|latest.*yml|enotfound/i.test(msg)
}

function send(win: BrowserWindow | null, channel: string, data?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true

  let retryTimer: ReturnType<typeof setTimeout> | null = null

  autoUpdater.on('update-available', (info) => {
    send(getMainWindow(), 'update-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    send(getMainWindow(), 'update-download-progress', {
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    cancelRetry()
    send(getMainWindow(), 'update-downloaded')
  })

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err?.message || err)
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
      if (isNoRelease(msg)) {
        return {
          success: true,
          currentVersion: autoUpdater.currentVersion?.version || '',
          latestVersion: '',
          updateAvailable: false,
          noReleasesYet: true
        }
      }
      if (isArtifactMissing(msg)) {
        return {
          success: true,
          currentVersion: autoUpdater.currentVersion?.version || '',
          latestVersion: '',
          updateAvailable: true,
          artifactPending: true
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
