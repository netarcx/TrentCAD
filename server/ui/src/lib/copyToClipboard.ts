/**
 * Copy `text` to the clipboard, falling back to the legacy textarea +
 * execCommand path when the modern Clipboard API isn't available (non-
 * secure context — i.e. the admin UI served over plain LAN HTTP).
 *
 * The Clipboard API throws in non-secure contexts; a swallowing
 * `catch{}` would leave whatever was in the clipboard before, which
 * looks like the copy "worked" but produced garbage. We try the
 * modern path first, fall through to the legacy path on any failure,
 * and surface a boolean so callers can show "✗ Failed" feedback.
 *
 * Original implementation lived inline in `Pins.tsx`; extracted here
 * so other pages (e.g. the Projects page) can reuse the same
 * safety behaviour.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through to legacy path */ }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // Keep the textarea off-screen and unfocusable for accessibility
    // but still in the DOM so select() + execCommand can see it.
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
