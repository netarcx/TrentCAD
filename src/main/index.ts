import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { setupIpc, stopWatching, stopRestServer, isPublishing } from './ipc'
import { startRestServer } from './rest'
import { initAutoUpdater } from './updater'
import { cleanupAskpass } from './auth'
import { flushMetaCommit } from './meta'

let mainWindow: BrowserWindow | null = null

// Holds a deep-link URL that arrived before the renderer was ready to
// receive it. Flushed by the renderer via `consume-pending-deep-link`
// once it has mounted.
let pendingDeepLink: string | null = null

function parseFrameCADUrl(rawUrl: string): { action: 'join'; url: string } | null {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'framecad:') return null
    // Both `framecad://join?url=...` (host=join) and `framecad:join?url=...`
    // (pathname=join) are valid depending on the platform's URL parser.
    //
    // Only `join` is supported today — `team?url=...` from the
    // coordination-repo era is intentionally ignored (silently). If
    // someone clicks an old README link, the app focuses to the
    // welcome screen and they enroll with a PIN like normal.
    const action = u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0]
    if (action === 'join') {
      const target = u.searchParams.get('url')
      if (!target) return null
      return { action: 'join', url: target }
    }
    return null
  } catch {
    return null
  }
}

function handleDeepLink(rawUrl: string | undefined): void {
  if (!rawUrl) return
  const parsed = parseFrameCADUrl(rawUrl)
  if (!parsed) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('deep-link', parsed)
  } else {
    // Renderer not ready yet — stash and let it pull on mount.
    pendingDeepLink = rawUrl
  }
}

// Register the framecad:// scheme so README "Open in FrameCAD" links
// route back to the app. On Windows this writes to the registry on first
// run; on macOS it relies on Info.plist (set via electron-builder).
if (!app.isDefaultProtocolClient('framecad')) {
  if (process.platform === 'win32' && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('framecad', process.execPath, [path.resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient('framecad')
  }
}

// Single-instance lock: a second launch (typically from a framecad:// URL
// on Windows/Linux) shovels its argv into the existing instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Focus the existing window even when there's no deep link — a user
    // double-clicking the icon expects the running app to come forward.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const url = argv.find(a => a.startsWith('framecad://'))
    handleDeepLink(url)
  })
}

// macOS delivers the URL via this event.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Layout floor that still fits 1366×768 laptops with the Windows
    // taskbar visible. Below this the responsive tiers in the renderer
    // (icon-only sidebar + DetailsPanel overlay) keep the UI usable
    // without things colliding. minHeight 680 gives the first-run
    // setup wizard enough room to render without internal scrolling.
    minWidth: 960,
    minHeight: 680,
    title: 'FrameCAD',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../build/icons/256x256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Drop the default Electron File/Edit/View menu so students don't see a
  // distracting menu bar — FrameCAD's own UI exposes everything they need.
  // Side effect: this also drops the default DevTools accelerator, so we
  // re-attach it as a `before-input-event` listener below; otherwise a
  // grey-screen failure of the renderer leaves the user with no way to
  // inspect what broke.
  Menu.setApplicationMenu(null)

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || mainWindow == null) return
    const key = input.key.toLowerCase()
    // Ctrl+Shift+I (Cmd+Shift+I on mac) → toggle DevTools
    if ((input.control || input.meta) && input.shift && key === 'i') {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    // F12 → toggle DevTools (familiar to Windows users)
    if (key === 'f12') {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    // Ctrl+R → reload the renderer. Useful when the dev-mode HMR
    // gets confused or to retry from a paint-error state.
    if ((input.control || input.meta) && !input.shift && key === 'r') {
      mainWindow.webContents.reload()
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ])
    menu.popup()
  })

  mainWindow.on('close', (e) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (isPublishing()) {
      e.preventDefault()
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Keep FrameCAD open', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Upload in progress',
        message: 'FrameCAD is uploading parts to GitHub.',
        detail: 'Closing now will interrupt the upload. Files that have already been uploaded will be safe, but anything still in flight will need to be re-uploaded on the next attempt.'
      })
      if (choice === 1) {
        // User chose to close anyway — bypass the guard and force-destroy
        mainWindow.destroy()
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

setupIpc(() => mainWindow)

ipcMain.handle('consume-pending-deep-link', () => {
  if (!pendingDeepLink) return null
  const parsed = parseFrameCADUrl(pendingDeepLink)
  pendingDeepLink = null
  return parsed
})

app.whenReady().then(async () => {
  // Cold launch from a deep link (Windows/Linux): URL arrives in argv.
  // Capture before createWindow so handleDeepLink can stash it for the
  // renderer to consume once mounted.
  if (process.platform !== 'darwin') {
    const url = process.argv.find(a => a.startsWith('framecad://'))
    if (url) pendingDeepLink = url
  }
  // Restore any previously-saved team-server enrollment from disk so
  // the renderer can read the snapshot synchronously on mount without
  // waiting for a fetch. Network refresh fires after the window's up.
  await (await import('./teamServer')).loadFromDisk().catch(() => { /* fresh install */ })
  createWindow()
  startRestServer()
  initAutoUpdater(() => mainWindow)
  // Kick the first network refresh shortly after the window appears
  // so the snapshot stays useful — but don't block boot on it.
  setTimeout(() => {
    import('./teamServer').then(m => m.refresh()).catch(() => { /* offline */ })
  }, 1500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatching()
  stopRestServer()
  if (process.platform !== 'darwin') app.quit()
})

// Best-effort cleanup of the GIT_ASKPASS temp script written under
// /tmp by auth.ts. Removes the token-bearing file so it doesn't
// survive a graceful exit. `before-quit` fires regardless of platform
// and before windows are destroyed.
app.on('before-quit', () => {
  flushMetaCommit().catch(() => { /* best-effort */ })
  cleanupAskpass().catch(() => { /* best-effort */ })
})
