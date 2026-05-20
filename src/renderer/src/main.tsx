import { createRoot } from 'react-dom/client'
import { Component, type ReactNode } from 'react'
import App from './App'
import BusyStripe from './components/BusyStripe'
import { wrapWindowApi } from './lib/apiBusy'
import '@fontsource/opendyslexic/400.css'
import '@fontsource/opendyslexic/700.css'
import './styles/global.css'

// Patch window.api so every IPC call increments / decrements a global
// activity counter. Must run BEFORE React mounts so the first calls
// from useEffect (getProjectConfig, etc.) are tracked.
wrapWindowApi()

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('React crash:', error) }
  render() {
    if (this.state.error) return <pre style={{ padding: 20, color: '#fb7185', background: '#1d1d1d', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', height: '100vh' }}>{this.state.error.message + '\n' + this.state.error.stack}</pre>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <BusyStripe />
    <App />
  </ErrorBoundary>
)
