import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initTheme } from './theme'

// Apply the user's saved theme (or 'system') BEFORE React mounts so
// the initial paint already has the right colors — without this the
// page flashes dark for one frame before the React tree's styles
// settle on the chosen palette.
initTheme()

createRoot(document.getElementById('root')!).render(<App />)
