/**
 * Admin UI theme controller.
 *
 * Three user-facing choices:
 *   - 'system': follow the OS's `prefers-color-scheme` (default for
 *     new installs — gives a free correct answer for ~95% of users
 *     without a setting trip).
 *   - 'light' / 'dark': explicit override.
 *
 * The CSS lives in styles.css under `:root` (dark defaults) and
 * `:root[data-theme="light"]` (light overrides). This module owns the
 * decision logic: read the user's stored preference, resolve 'system'
 * against the actual OS pref, and apply the right `data-theme`
 * attribute to <html>. Also keeps the attribute in sync when the OS
 * preference flips at runtime (e.g. macOS auto-dark at sunset) — but
 * only while the user is in 'system' mode.
 *
 * Persisted in localStorage so the choice survives sign-outs and
 * cross-browser sessions; absent key = 'system'.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'framecad-admin-theme'

export function getStoredTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch { /* localStorage blocked — fall through to default */ }
  return 'system'
}

export function setStoredTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, choice)
  } catch { /* localStorage blocked — apply for this session only */ }
  applyTheme(choice)
}

/**
 * Resolve a stored choice to a concrete 'light' | 'dark' by consulting
 * the OS's prefers-color-scheme when the choice is 'system'.
 */
export function resolvedTheme(choice: ThemeChoice = getStoredTheme()): 'light' | 'dark' {
  if (choice === 'light' || choice === 'dark') return choice
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

function applyTheme(choice: ThemeChoice): void {
  const resolved = resolvedTheme(choice)
  document.documentElement.setAttribute('data-theme', resolved)
}

/**
 * Call once at app start. Applies the saved theme and wires a listener
 * so the OS prefers-color-scheme flipping live (macOS at sunset, etc.)
 * is reflected — but only when the user is in 'system' mode. If they
 * picked an explicit 'light' / 'dark', the OS toggle is ignored.
 */
export function initTheme(): void {
  applyTheme(getStoredTheme())
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  // Both addEventListener and the legacy `addListener` are supported
  // because Safari < 14 only has the deprecated form. We use whichever
  // is available; modern browsers ignore the fallback.
  const handler = (): void => {
    if (getStoredTheme() === 'system') applyTheme('system')
  }
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler)
  } else if (typeof (mq as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener === 'function') {
    ;(mq as MediaQueryList & { addListener: (cb: () => void) => void }).addListener(handler)
  }
}
