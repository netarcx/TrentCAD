import { createRoot } from 'react-dom/client'
import { Component, type ReactNode } from 'react'
import App from './App'
import BusyStripe from './components/BusyStripe'
import { wrapWindowApi } from './lib/apiBusy'
import '@fontsource/opendyslexic/400.css'
import '@fontsource/opendyslexic/700.css'
import './styles/global.css'

/**
 * Pre-React safety net. If anything throws before / during the
 * React root mount (e.g. a preload contract mismatch, a synchronous
 * crash in wrapWindowApi, a missing #root, an ESM resolution
 * failure), the user sees a useful error string instead of a blank
 * grey window. React's own ErrorBoundary only catches AFTER mount,
 * so this fills the gap.
 */
function paintFatalError(label: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(label, err)
  try {
    const root = document.getElementById('root') ?? document.body
    if (!root) return
    const e = err as { message?: string; stack?: string }
    const message = (e && e.message) || String(err)
    const stack = (e && e.stack) || ''
    root.innerHTML = ''
    const pre = document.createElement('pre')
    pre.style.cssText = [
      'padding:20px',
      'color:#fb7185',
      'background:#1d1d1d',
      'overflow:auto',
      'white-space:pre-wrap',
      'word-break:break-word',
      'height:100vh',
      'margin:0',
      'font:13px/1.4 SF Mono, Consolas, monospace',
    ].join(';')
    pre.textContent =
      `FrameCAD failed to start.\n\n${label}\n\n${message}\n\n${stack}`
    root.appendChild(pre)
  } catch { /* nothing we can do here */ }
}

// Track whether React has mounted. The fatal-error overlay is for
// PRE-mount catastrophes (preload contract mismatch, ESM resolution
// failure, missing #root) — once React owns the page, a runtime
// unhandled promise rejection (e.g. a Chrome clipboard write that
// rejects with "Document is not focused" on a button click while
// the window hasn't fully focused yet) shouldn't nuke the whole UI
// back to a "FrameCAD failed to start" screen. Post-mount, those
// belong in console.error so dev tools can find them, but the user
// keeps a working app.
let reactMounted = false
window.addEventListener('error', e => {
  if (reactMounted) {
    // eslint-disable-next-line no-console
    console.error('Uncaught error (post-mount):', e.error ?? e.message)
    return
  }
  paintFatalError('Uncaught error', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', e => {
  if (reactMounted) {
    // eslint-disable-next-line no-console
    console.error('Unhandled promise rejection (post-mount):', e.reason)
    return
  }
  paintFatalError('Unhandled promise rejection', e.reason)
})

try {
  // Patch window.api so every IPC call increments / decrements a global
  // activity counter. Must run BEFORE React mounts so the first calls
  // from useEffect are tracked.
  wrapWindowApi()
} catch (err) {
  // Non-fatal — without the wrapper the busy stripe just won't move.
  // eslint-disable-next-line no-console
  console.warn('wrapWindowApi failed, activity indicator disabled:', err)
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('React crash:', error) }
  render() {
    if (this.state.error) return <pre style={{ padding: 20, color: '#fb7185', background: '#1d1d1d', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: '100vh' }}>{this.state.error.message + '\n' + this.state.error.stack}</pre>
    return this.props.children
  }
}

try {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Renderer #root element is missing — index.html out of sync with the bundle?')
  createRoot(rootEl).render(
    <ErrorBoundary>
      <BusyStripe />
      <App />
    </ErrorBoundary>
  )
  // Flip the flag in a microtask so any synchronous error from
  // createRoot still hits paintFatalError, but subsequent runtime
  // errors after the first React tick are treated as post-mount.
  queueMicrotask(() => { reactMounted = true })
} catch (err) {
  paintFatalError('Failed to mount React root', err)
}
