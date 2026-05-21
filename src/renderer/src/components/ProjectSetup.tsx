import { useState, useEffect, useCallback, useRef } from 'react'
import { FilePlus2, Search, Download, FolderOpen, Factory, Pin, PinOff, X, Settings, Users, UserPlus } from 'lucide-react'
import logoUrl from '../assets/logo.png'
import BrowseProjects from './BrowseProjects'
import TeamProjects from './TeamProjects'
import TeamEnroll from './TeamEnroll'
import { prepareSlamSnapshot, triggerWaterSlam } from '../lib/water-slam'
import type { GitHubAuthStatus, GlobalAdminConfig, ProjectConfig, TeamSnapshot } from '@shared/types'

interface Props {
  onCreateProject: (name: string, path: string, remote: string, isCotsProject?: boolean) => Promise<void>
  onJoinProject: (url: string, path: string) => Promise<void>
  onOpenProject: (path: string) => Promise<void>
  /** Open the most recently used project and jump straight into the
   *  Manufacturing View (shop-floor mode). Disabled when there are no
   *  recent projects to open. */
  onEnterManufacturingView?: () => void
  onOpenAdmin?: () => void
  isLoading: boolean
  /**
   * Install-wide admin settings (Team + Browse). Used to enable the
   * welcome-screen Browse button and the org-aware Create flow.
   */
  globalAdmin?: GlobalAdminConfig
  /** When set, jump straight into the Join Project flow with this URL
   *  prefilled. Used by the framecad:// deep-link handler so README
   *  "Open in FrameCAD" links land on a ready-to-go join form. */
  prefilledJoinUrl?: string | null
  /** Monotonic counter bumped on every deep-link arrival so the same
   *  URL can re-trigger the prefill (e.g. user backs out then clicks
   *  the link again). */
  prefilledJoinSeq?: number
  /** Team-server snapshot from App level — drives the welcome-screen
   *  enrollment prompt and the Team Projects browser. */
  teamSnapshot: TeamSnapshot | null
  /** Force a fresh fetch from the team server (e.g. after enrollment). */
  onTeamRefresh?: () => Promise<void>
}

type Mode = 'select' | 'create' | 'join' | 'open' | 'enroll'

// Module-scoped so the once-per-session welcome-logo intro animation
// only plays the first time the welcome screen mounts in this process.
// Resets on every fresh app launch (Electron starts a new renderer).
let welcomeIntroShown = false
// Set true after the welcome-intro's animationend fires (or skipped
// entirely on re-mounts). Pre-capture for the slam easter egg waits
// on this so it doesn't snapshot the logo mid-spin.
let welcomeIntroFinished = false

// 6-click slam easter egg unlocks a session-persistent click-wave
// effect: every mousedown spawns a small ripple at the cursor. Flag
// and listener are module-scoped so they survive ProjectSetup
// unmounting when a project is opened.
let clickWavesInstalled = false

function spawnClickRipple(cx: number, cy: number): void {
  // Two staggered ripples per click so a trailing wave coexists with
  // the leading one — same trick a real droplet does on a puddle.
  // Tiny stagger (90 ms) keeps both wavefronts visible at once.
  for (let i = 0; i < 2; i++) {
    const ripple = document.createElement('div')
    ripple.className = 'click-ripple'
    ripple.style.setProperty('--impact-x', `${cx}px`)
    ripple.style.setProperty('--impact-y', `${cy}px`)
    ripple.style.animationDelay = `${i * 0.09}s`
    document.body.appendChild(ripple)
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true })
  }
}

function installClickWaves(): void {
  if (clickWavesInstalled) return
  clickWavesInstalled = true
  // Capture phase + passive so the listener fires for every mousedown
  // that reaches the DOM, even if a child stops propagation, and so
  // we never interfere with the actual click handling.
  document.addEventListener(
    'mousedown',
    (e: MouseEvent) => spawnClickRipple(e.clientX, e.clientY),
    { capture: true, passive: true }
  )
}

export default function ProjectSetup({ onCreateProject, onJoinProject, onOpenProject, onEnterManufacturingView, onOpenAdmin, isLoading, globalAdmin, prefilledJoinUrl, prefilledJoinSeq, teamSnapshot, onTeamRefresh }: Props) {
  const [mode, setMode] = useState<Mode>('select')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [remote, setRemote] = useState('')
  const [url, setUrl] = useState('')
  // React to deep-link arrivals: prefill the join URL field and snap to
  // the join mode. Keyed on the seq counter so re-clicking the same
  // link still re-routes the user.
  useEffect(() => {
    if (prefilledJoinUrl) {
      setUrl(prefilledJoinUrl)
      setMode('join')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefilledJoinSeq, prefilledJoinUrl])
  const [showTeamProjects, setShowTeamProjects] = useState(false)
  const [isCotsProject, setIsCotsProject] = useState(false)
  const [recentProjects, setRecentProjects] = useState<ProjectConfig[]>([])
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
  const [resetupMsg, setResetupMsg] = useState<string | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  // True between clicking "Sign in" and seeing the gh CLI flip to
  // logged-in. While true we auto-poll status every 3 s so most users
  // never need to click anything to confirm sign-in landed.
  const [signInPending, setSignInPending] = useState(false)
  const [showBrowse, setShowBrowse] = useState(false)
  const [creatingOnGitHub, setCreatingOnGitHub] = useState(false)
  const [createMsg, setCreateMsg] = useState<string | null>(null)

  const orgConfigured = (globalAdmin?.gitHubOrg || '').trim()
  const projectPrefix = (globalAdmin?.projectPrefix || '').trim()
  const canBrowse = !!orgConfigured && !!authStatus?.loggedIn

  const refreshAuth = useCallback(() => {
    window.api.githubAuthStatus().then(setAuthStatus).catch(() => {})
  }, [])

  useEffect(() => {
    window.api.getRecentProjects().then(setRecentProjects).catch(() => {})
    refreshAuth()
  }, [refreshAuth])

  const handleGitHubLogin = async () => {
    setLoggingIn(true)
    setResetupMsg(null)
    try {
      const result = await window.api.githubLogin()
      if (result.launched) {
        setSignInPending(true)
        setResetupMsg('Sign-in opened in a new window. Finish there — FrameCAD will detect it automatically.')
      } else if (result.error?.startsWith('MANUAL_SIGNIN_REQUIRED:')) {
        // Mac/Linux: we can't reliably spawn a terminal, so we tell the
        // user to run the command themselves. Strip the sentinel prefix.
        setSignInPending(true)
        setResetupMsg(result.error.slice('MANUAL_SIGNIN_REQUIRED:'.length))
      } else {
        setResetupMsg(result.error || 'Could not launch GitHub login')
      }
    } finally {
      setLoggingIn(false)
    }
  }

  // While sign-in is pending, poll auth status every 3 s so we can
  // auto-detect when the user completes sign-in in the other window.
  // Stops itself once we see loggedIn=true; bounded at ~2 minutes so we
  // don't poll forever if the user abandons sign-in.
  useEffect(() => {
    if (!signInPending) return
    let cancelled = false
    const start = Date.now()
    const interval = setInterval(async () => {
      if (cancelled || Date.now() - start > 120000) {
        setSignInPending(false)
        return
      }
      try {
        const status = await window.api.githubAuthStatus()
        if (cancelled) return
        setAuthStatus(status)
        if (status.loggedIn) {
          setSignInPending(false)
          setResetupMsg(`✓ Signed in as ${status.username}`)
        }
      } catch { /* ignore — try again next tick */ }
    }, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [signInPending])

  const handleBrowse = async () => {
    const dir = await window.api.selectDirectory()
    if (dir) setPath(dir)
  }

  const refreshRecents = useCallback(() => {
    window.api.getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  const handleBrowseAndOpen = async () => {
    const dir = await window.api.selectDirectory()
    if (dir) onOpenProject(dir)
  }

  const togglePin = useCallback(async (p: ProjectConfig) => {
    try {
      await window.api.setProjectPinned(p.path, !p.pinned)
      refreshRecents()
    } catch (err) {
      setResetupMsg(`Could not ${p.pinned ? 'unpin' : 'pin'} project: ${(err as Error).message}`)
    }
  }, [refreshRecents])

  const removeFromRecent = useCallback(async (p: ProjectConfig) => {
    try {
      await window.api.removeRecentProject(p.path)
      refreshRecents()
    } catch (err) {
      setResetupMsg(`Could not remove project: ${(err as Error).message}`)
    }
  }, [refreshRecents])

  const pinnedProjects = recentProjects.filter(p => p.pinned)
  const unpinnedProjects = recentProjects.filter(p => !p.pinned)

  // Logo double-click easter egg
  const logoRef = useRef<HTMLDivElement | null>(null)
  // Snapshot pre-captured on welcome-screen mount so the 6-click slam
  // ripple can fire immediately at the impact moment without paying
  // an html-to-image capture penalty (which would otherwise stall the
  // animation 100–200 ms after the logo touches the ground).
  // 7-click easter egg / Ctrl+7: DVD-screensaver-style bouncing of the
  // welcome logo when the app loses focus or the mouse is idle. A
  // separate wrapper around the logo carries the bounce translate so
  // the inner click-animations (slam, flip, etc.) can still apply their
  // own transforms on top.
  const logoBounceRef = useRef<HTMLDivElement | null>(null)
  const logoSpacerRef = useRef<HTMLDivElement | null>(null)
  const screensaverActiveRef = useRef(false)
  const bounceStateRef = useRef({
    x: 0, y: 0, vx: 0, vy: 0, naturalX: 0, naturalY: 0
  })
  const rafIdRef = useRef<number | null>(null)
  const idleTimerRef = useRef<number | null>(null)
  // Tracks the 550 ms setTimeout that drops the bounce wrap out of
  // position:fixed at the end of stopScreensaver's glide-back. Held in
  // a ref so the unmount cleanup (and any subsequent stopScreensaver
  // call) can cancel it instead of letting it fire on a detached DOM.
  const stopScreensaverTimerRef = useRef<number | null>(null)
  const SCREENSAVER_IDLE_MS = 45_000
  const SCREENSAVER_SPEED = 130 // px/s — DVD-ish, slow enough to read
  // Bounds for +/- speed adjustments while screensaver is active.
  const SCREENSAVER_MIN_SPEED = 25
  const SCREENSAVER_MAX_SPEED = 4800

  const adjustScreensaverSpeed = useCallback((factor: number) => {
    if (!screensaverActiveRef.current) return
    const state = bounceStateRef.current
    const cur = Math.hypot(state.vx, state.vy)
    if (cur === 0) return
    const target = Math.max(
      SCREENSAVER_MIN_SPEED,
      Math.min(SCREENSAVER_MAX_SPEED, cur * factor)
    )
    const scale = target / cur
    state.vx *= scale
    state.vy *= scale
  }, [])

  const stopScreensaver = useCallback(() => {
    if (!screensaverActiveRef.current) return
    screensaverActiveRef.current = false
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = null
    // Cancel any in-flight glide-back timer from a previous stop call
    // before scheduling a new one — otherwise a stop-restart-stop
    // sequence could double-fire the cleanup and clobber the
    // in-progress screensaver's inline styles.
    if (stopScreensaverTimerRef.current !== null) {
      clearTimeout(stopScreensaverTimerRef.current)
      stopScreensaverTimerRef.current = null
    }
    const wrap = logoBounceRef.current
    if (!wrap) return
    // Smooth glide back to the natural layout position. The wrapper
    // is still position:fixed during the transition — translate(0, 0)
    // lands it at its captured natural rect, which is pixel-identical
    // to where the in-flow version would sit.
    wrap.style.transition = 'transform 500ms cubic-bezier(0.22, 1, 0.36, 1)'
    wrap.style.transform = 'translate(0, 0)'
    stopScreensaverTimerRef.current = window.setTimeout(() => {
      stopScreensaverTimerRef.current = null
      const w = logoBounceRef.current
      if (!w) return
      // Drop out of fixed positioning and clear the spacer; wrapper
      // resumes its natural flex-flow position with the same bounding
      // box, so this swap is invisible.
      w.style.transition = ''
      w.style.transform = ''
      w.style.position = ''
      w.style.left = ''
      w.style.top = ''
      w.style.width = ''
      w.style.height = ''
      const spacer = logoSpacerRef.current
      if (spacer) {
        spacer.style.display = ''
        spacer.style.width = ''
        spacer.style.height = ''
      }
      document.body.classList.remove('logo-screensaver-active')
    }, 550)
  }, [])

  const startScreensaver = useCallback(() => {
    if (screensaverActiveRef.current) return
    const wrap = logoBounceRef.current
    if (!wrap) return
    // Don't kick off during the welcome-intro spin — looks chaotic.
    if (!welcomeIntroFinished) return
    // Screensaver always uses the standard logo colors.
    setLogoInverted(false)
    const rect = wrap.getBoundingClientRect()
    const state = bounceStateRef.current
    state.naturalX = rect.left
    state.naturalY = rect.top
    state.x = rect.left
    state.y = rect.top
    const angle = Math.random() * Math.PI * 2
    state.vx = Math.cos(angle) * SCREENSAVER_SPEED
    state.vy = Math.sin(angle) * SCREENSAVER_SPEED
    screensaverActiveRef.current = true
    // Pop wrapper into fixed positioning at its current natural rect,
    // and show the spacer so .setup-screen's flex layout doesn't
    // reflow (or trigger its overflow-y:auto scrollbar when the
    // wrapper translates near the bottom edge).
    wrap.style.transition = ''
    wrap.style.position = 'fixed'
    wrap.style.left = `${rect.left}px`
    wrap.style.top = `${rect.top}px`
    wrap.style.width = `${rect.width}px`
    wrap.style.height = `${rect.height}px`
    // Size the spacer to the wrap's exact rect rather than relying on
    // the CSS rule's hardcoded 192x192 — devicePixelRatio, font scaling
    // and parent transforms can all shift the actual rendered size,
    // which would otherwise leave the following elements (title, cards)
    // shifted up by the difference.
    const spacer = logoSpacerRef.current
    if (spacer) {
      spacer.style.display = 'block'
      spacer.style.width = `${rect.width}px`
      spacer.style.height = `${rect.height}px`
    }
    document.body.classList.add('logo-screensaver-active')
    let last = performance.now()
    const tick = (now: number): void => {
      if (!screensaverActiveRef.current) return
      const dt = (now - last) / 1000
      last = now
      const w = rect.width
      const h = rect.height
      state.x += state.vx * dt
      state.y += state.vy * dt
      let hitX = false
      let hitY = false
      if (state.x < 0)                       { state.x = 0;                       state.vx = -state.vx; hitX = true }
      if (state.x + w > window.innerWidth)   { state.x = window.innerWidth - w;   state.vx = -state.vx; hitX = true }
      if (state.y < 0)                       { state.y = 0;                       state.vy = -state.vy; hitY = true }
      if (state.y + h > window.innerHeight)  { state.y = window.innerHeight - h;  state.vy = -state.vy; hitY = true }
      // Corner shot (two walls in the same frame) — slingshot 3× boost,
      // capped at the same max-speed used by the +/- adjuster.
      if (hitX && hitY) {
        const cur = Math.hypot(state.vx, state.vy)
        if (cur > 0) {
          const target = Math.min(SCREENSAVER_MAX_SPEED, cur * 3)
          const scale = target / cur
          state.vx *= scale
          state.vy *= scale
        }
      }
      const dx = state.x - state.naturalX
      const dy = state.y - state.naturalY
      wrap.style.transform = `translate(${dx}px, ${dy}px)`
      rafIdRef.current = requestAnimationFrame(tick)
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [])

  // Idle detection (mousemove) + focus/blur. Active only on welcome
  // and only when the user has opted in via Settings > About.
  useEffect(() => {
    if (mode !== 'select') return
    const enabled = localStorage.getItem('screensaver-enabled') === 'true'
    if (!enabled) return
    const resetIdle = (): void => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(startScreensaver, SCREENSAVER_IDLE_MS)
    }
    const onActivity = (): void => {
      stopScreensaver()
      resetIdle()
    }
    const onBlur = (): void => startScreensaver()
    const onFocus = (): void => stopScreensaver()
    document.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    resetIdle()
    return () => {
      document.removeEventListener('mousemove', onActivity)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      stopScreensaver()
      if (stopScreensaverTimerRef.current !== null) {
        window.clearTimeout(stopScreensaverTimerRef.current)
        stopScreensaverTimerRef.current = null
      }
    }
  }, [mode, startScreensaver, stopScreensaver])

  // 1-click / Ctrl+1: toggle the welcome logo's purple↔white. We
  // generate the inverted PNG once at mount via pixel-swap on a canvas,
  // then flip the imgs' src between original and inverted on demand.
  const [logoInverted, setLogoInverted] = useState(false)
  const invertedLogoSrc = useRef<string | null>(null)
  useEffect(() => {
    if (mode !== 'select') return
    if (invertedLogoSrc.current) return
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const px = data.data
      // Classify each non-transparent pixel as "white-ish" or "purple-ish"
      // by whether its luminance is above mid. The logo is two-color
      // (plus transparent), so a luminance threshold is enough. Purple
      // fill color is sampled from the logo's actual hex.
      const PURPLE_R = 73, PURPLE_G = 29, PURPLE_B = 128
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue
        const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
        if (lum > 160) {
          px[i] = PURPLE_R; px[i + 1] = PURPLE_G; px[i + 2] = PURPLE_B
        } else {
          px[i] = 255; px[i + 1] = 255; px[i + 2] = 255
        }
      }
      ctx.putImageData(data, 0, 0)
      invertedLogoSrc.current = canvas.toDataURL('image/png')
    }
    img.src = logoUrl
  }, [mode])

  const toggleLogoInverted = useCallback(() => {
    setLogoInverted(v => !v)
  }, [])

  const cachedSlamSnapshot = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (mode !== 'select') return
    let cancelled = false
    const capture = () => {
      if (cancelled) return
      prepareSlamSnapshot().then(canvas => {
        if (!cancelled) cachedSlamSnapshot.current = canvas
      })
    }
    if (welcomeIntroFinished) {
      // Intro already done (re-mount, or first mount past its end) —
      // safe to snapshot now. The logo is at rest.
      capture()
    } else {
      // Intro is currently spinning the logo. Polling for the flag
      // keeps this effect tolerant of however long the intro takes
      // (currently 2.8s) without coupling to its exact duration.
      const id = setInterval(() => {
        if (welcomeIntroFinished) {
          clearInterval(id)
          capture()
        }
      }, 200)
      return () => { cancelled = true; clearInterval(id) }
    }
    return () => { cancelled = true }
  }, [mode])
  const spinLogo = (cls: 'spinning' | 'flipping' | 'spinning-flipping' | 'chaos' | 'slam') => {
    const el = logoRef.current
    if (!el) return
    // Already animating — let it finish, ignore the extra click. Avoids
    // the visual glitch of class-toggling mid-animation.
    if (
      el.classList.contains('spinning') ||
      el.classList.contains('flipping') ||
      el.classList.contains('spinning-flipping') ||
      el.classList.contains('chaos') ||
      el.classList.contains('slam') ||
      el.classList.contains('welcome-intro')
    ) return

    // Any non-toggle animation reverts the logo to its standard colors
    // so the spin/flip/slam plays on the original purple/white design.
    setLogoInverted(false)

    // 5-click easter egg: randomize the rotation direction on each axis
    // and the run duration. Magnitudes vary too so it doesn't feel like
    // the same animation just played twice. Values are pushed in via
    // CSS custom properties so the keyframe stays static.
    if (cls === 'chaos') {
      const durationMs = 3000 + Math.floor(Math.random() * 4000) // 3–7 s
      const turns = () => (2 + Math.floor(Math.random() * 5)) * 360 // 2–6 full turns
      const sign = () => (Math.random() < 0.5 ? -1 : 1)
      el.style.setProperty('--chaos-duration', `${durationMs}ms`)
      el.style.setProperty('--chaos-z', `${sign() * turns()}deg`)
      el.style.setProperty('--chaos-y', `${sign() * turns()}deg`)
    }

    // 6-click easter egg: randomize the bounce-in so each fire feels
    // distinct — initial rotation direction + amount, squash intensity,
    // and bounce height. Values are pushed into CSS custom properties
    // that the slam keyframe reads.
    if (cls === 'slam') {
      const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
      // No spin — only the fall distance + impact dynamics vary. A
      // taller initial drop over the same keyframe duration reads as
      // a faster impact; the squash/bounce ranges give the rebound
      // distinct energy each fire.
      el.style.setProperty('--slam-fall-from', `${-rand(100, 180).toFixed(0)}vh`)
      el.style.setProperty('--slam-squash-x', `${rand(1.10, 1.32).toFixed(3)}`)
      el.style.setProperty('--slam-squash-y', `${rand(0.58, 0.78).toFixed(3)}`)
      el.style.setProperty('--slam-squash-down', `${rand(6, 14).toFixed(1)}px`)
      el.style.setProperty('--slam-bounce', `${-rand(10, 22).toFixed(1)}px`)
    }

    // Slam starts the logo at translateY(-130vh), which expands the
    // scroll container's overflow upward and pops a scrollbar for the
    // duration of the fall. Hide overflow on the closest .setup-screen
    // BEFORE adding the .slam class so the next paint already has
    // overflow hidden — no chance of a one-frame scrollbar flash. Set
    // both a class (for the !important CSS) and an inline style; the
    // inline style wins over any cascade-ordering edge case.
    const setupScreen = cls === 'slam'
      ? (el.closest('.setup-screen') as HTMLElement | null)
      : null
    if (setupScreen) {
      setupScreen.classList.add('slam-active')
      setupScreen.style.overflow = 'hidden'
    }

    el.classList.add(cls)

    // Fire the water-ripple right at the moment the logo hits the
    // ground (60% of the 1500ms keyframe = 900ms). Snapshot is
    // pre-captured on welcome-screen mount so there's no capture
    // latency at this moment.
    let slamCleanup: number | null = null
    if (cls === 'slam') {
      slamCleanup = window.setTimeout(() => spawnSlamImpact(el), 900)
    }

    const onEnd = () => {
      el.classList.remove(cls)
      if (cls === 'chaos') {
        el.style.removeProperty('--chaos-duration')
        el.style.removeProperty('--chaos-z')
        el.style.removeProperty('--chaos-y')
      }
      if (cls === 'slam') {
        el.style.removeProperty('--slam-fall-from')
        el.style.removeProperty('--slam-squash-x')
        el.style.removeProperty('--slam-squash-y')
        el.style.removeProperty('--slam-squash-down')
        el.style.removeProperty('--slam-bounce')
        if (setupScreen) {
          setupScreen.classList.remove('slam-active')
          setupScreen.style.overflow = ''
        }
      }
      if (slamCleanup !== null) {
        window.clearTimeout(slamCleanup)
        slamCleanup = null
      }
      el.removeEventListener('animationend', onEnd)
    }
    el.addEventListener('animationend', onEnd)
  }

  // Spawn the impact effects: a brief body shake and four expanding
  // wave rings that emanate from the logo's center. Rings are fixed-
  // position so they cover the whole viewport regardless of the
  // welcome-screen's flex layout.
  function spawnSlamImpact(logoEl: HTMLDivElement) {
    const rect = logoEl.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    // Actual pixel displacement of the entire DOM via Pixi.js. Snapshot
    // is pre-captured on mount so there's no latency at impact moment;
    // it shows the welcome screen at rest, which matches the live DOM
    // state at the moment of impact (translateY(0) in the keyframe).
    void triggerWaterSlam(cx, cy, cachedSlamSnapshot.current)
  }

  // First time the welcome screen mounts in this app session, the logo
  // does a 5-rotation intro that decelerates near the end. We use a
  // module-level flag (not localStorage) so it plays on every fresh
  // launch but doesn't replay when the user closes a project and comes
  // back to the welcome screen mid-session.
  useEffect(() => {
    if (mode !== 'select') return
    if (welcomeIntroShown) {
      // Already played in this session — slam-snapshot pre-capture
      // can run immediately.
      welcomeIntroFinished = true
      return
    }
    const el = logoRef.current
    if (!el) return
    welcomeIntroShown = true
    el.classList.add('welcome-intro')
    const onEnd = () => {
      el.classList.remove('welcome-intro')
      welcomeIntroFinished = true
      el.removeEventListener('animationend', onEnd)
    }
    el.addEventListener('animationend', onEnd)
    return () => el.removeEventListener('animationend', onEnd)
  }, [mode])
  // Ctrl/Cmd+2..5 mirror the click-count easter eggs so they're
  // reachable from the keyboard. Active only on the welcome screen
  // since that's the only place the logo is mounted.
  useEffect(() => {
    if (mode !== 'select') return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      switch (e.key) {
        case '1': e.preventDefault(); toggleLogoInverted(); break
        case '2': e.preventDefault(); stopScreensaver(); spinLogo('spinning'); break
        case '3': e.preventDefault(); stopScreensaver(); spinLogo('flipping'); break
        case '4': e.preventDefault(); stopScreensaver(); spinLogo('spinning-flipping'); break
        case '5': e.preventDefault(); stopScreensaver(); spinLogo('chaos'); break
        case '6': e.preventDefault(); stopScreensaver(); spinLogo('slam'); break
        case '7':
          e.preventDefault()
          if (screensaverActiveRef.current) stopScreensaver()
          else startScreensaver()
          break
        // Ctrl/Cmd + or = speeds up the screensaver bounce; + and - keys
        // only work while it's active.
        case '+':
        case '=':
          if (screensaverActiveRef.current) {
            e.preventDefault()
            adjustScreensaverSpeed(1.25)
          }
          break
        case '-':
        case '_':
          if (screensaverActiveRef.current) {
            e.preventDefault()
            adjustScreensaverSpeed(0.8)
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, startScreensaver, stopScreensaver, adjustScreensaverSpeed, toggleLogoInverted])

  const clickCountRef = useRef(0)
  const clickTimerRef = useRef<number | null>(null)
  const onLogoClick = () => {
    clickCountRef.current += 1
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = window.setTimeout(() => {
      const n = clickCountRef.current
      clickCountRef.current = 0
      clickTimerRef.current = null
      if (n >= 6) spinLogo('slam')
      else if (n === 5) spinLogo('chaos')
      else if (n === 4) spinLogo('spinning-flipping')
      else if (n === 3) spinLogo('flipping')
      else if (n === 1) toggleLogoInverted()
      else if (n === 2) spinLogo('spinning')
    }, 280)
  }

  if (mode === 'enroll') {
    return (
      <TeamEnroll
        onBack={() => setMode('select')}
        onEnrolled={() => {
          // Push will refresh the snapshot, but force a fetch too so
          // the rest of the welcome screen (team projects panel) sees
          // the new state on the very next render.
          onTeamRefresh?.().catch(() => { /* offline */ })
          setMode('select')
        }}
      />
    )
  }

  if (mode === 'select') {
    return (
      <div className="setup-screen">
        {onOpenAdmin && (
          <button
            className="welcome-admin-btn"
            onClick={onOpenAdmin}
            title="Settings"
          >
            <Settings size={14} strokeWidth={1.75} />
            <span>Settings</span>
          </button>
        )}
        <div ref={logoSpacerRef} className="setup-logo-spacer" aria-hidden="true" />
        <div ref={logoBounceRef} className="setup-logo-bounce-wrap">
          <div
            ref={logoRef}
            className="setup-logo"
            onClick={onLogoClick}
            role="img"
            aria-label="FrameCAD"
          >
            {Array.from({ length: 11 }, (_, i) => (
              <img
                key={i}
                className="setup-logo-face"
                src={logoInverted && invertedLogoSrc.current ? invertedLogoSrc.current : logoUrl}
                alt=""
                aria-hidden="true"
                style={{ transform: `translateZ(${(i - 5) * 2}px)` }}
                draggable={false}
              />
            ))}
          </div>
        </div>
        <div className="setup-header">
          <h1>FrameCAD FRC</h1>
          <p className="subtitle">File / Revision / Asset Management Engine</p>
          {globalAdmin?.teamName && (
            <p className="subtitle subtitle-team">for {globalAdmin.teamName}</p>
          )}
        </div>
        {/* Until the user is enrolled with a team, the welcome screen
            is intentionally minimal — just the logo, the Enroll card,
            and the Settings button in the corner. Everything else
            (pinned/recent projects, GitHub auth, the create / browse /
            open / mfg actions) is gated behind enrollment so a fresh
            install can't be used in a state where the team can't see
            who's making changes. */}
        {teamSnapshot?.enrolled && pinnedProjects.length > 0 && (
          <div className="pinned-projects">
            {pinnedProjects.map(p => (
              <div key={p.path} className="pinned-project-card" title={p.path}>
                <button
                  type="button"
                  className="pinned-project-open"
                  onClick={() => onOpenProject(p.path)}
                  disabled={isLoading}
                >
                  <Pin size={18} strokeWidth={1.75} className="pinned-project-pin" />
                  <span className="pinned-project-name">{p.name}</span>
                  <span className="pinned-project-path">{p.path}</span>
                </button>
                <button
                  type="button"
                  className="pinned-project-unpin"
                  onClick={() => togglePin(p)}
                  title="Unpin from welcome screen"
                  aria-label="Unpin"
                >
                  <PinOff size={14} strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!teamSnapshot?.enrolled && (
          <div className="setup-cards setup-cards-team">
            <button className="setup-card" onClick={() => setMode('enroll')}>
              <span className="card-icon"><UserPlus size={32} strokeWidth={1.5} /></span>
              <span className="card-title">Enroll with Team</span>
              <span className="card-desc">
                Enter a PIN from your<br />team's admin
              </span>
            </button>
          </div>
        )}

        {/* Each home-screen card is gated on its own capability flag,
            set by the admin at PIN-issue time and editable later from
            the team-server web UI. The set of cards a student sees is
            exactly what the admin curated — nothing more. */}
        {teamSnapshot?.enrolled && (() => {
          const caps = teamSnapshot.me?.capabilities
          const visibleCards: React.ReactNode[] = []
          if (caps?.createProject) {
            visibleCards.push(
              <button key="create" className="setup-card" onClick={() => setMode('create')}>
                <span className="card-icon"><FilePlus2 size={32} strokeWidth={1.5} /></span>
                <span className="card-title">Create Project</span>
                <span className="card-desc">Start a new CAD project<br />with version control</span>
              </button>,
            )
          }
          if (caps?.browseTeamProjects) {
            visibleCards.push(
              <button
                key="browse-team"
                className="setup-card"
                onClick={() => setShowTeamProjects(true)}
                disabled={!teamSnapshot.projects?.length}
                title={teamSnapshot.projects?.length
                  ? 'Browse projects registered in your team server'
                  : 'No projects registered yet — ask your admin'}
              >
                <span className="card-icon"><Users size={32} strokeWidth={1.5} /></span>
                <span className="card-title">Team Projects</span>
                <span className="card-desc">Browse projects from<br />the team server</span>
              </button>,
            )
          }
          if (caps?.openProject) {
            visibleCards.push(
              <button key="open" className="setup-card" onClick={() => setMode('open')}>
                <span className="card-icon"><FolderOpen size={32} strokeWidth={1.5} /></span>
                <span className="card-title">Open Project</span>
                <span className="card-desc">Open an existing<br />project folder</span>
              </button>,
            )
          }
          if (caps?.manufacturingView) {
            visibleCards.push(
              <button
                key="mfg"
                className="setup-card"
                onClick={() => onEnterManufacturingView?.()}
                disabled={!onEnterManufacturingView || recentProjects.length === 0}
                title={recentProjects.length === 0
                  ? 'Open or create a project first — the manufacturing queue lives inside a project'
                  : 'Shop-floor view: just what needs to be made'}
              >
                <span className="card-icon"><Factory size={32} strokeWidth={1.5} /></span>
                <span className="card-title">Manufacturing View</span>
                <span className="card-desc">Shop-floor queue<br />grouped by method</span>
              </button>,
            )
          }
          if (visibleCards.length === 0) {
            return (
              <div className="setup-cards-empty hint" style={{ textAlign: 'center', marginTop: 24, opacity: 0.8 }}>
                You're enrolled, but your admin hasn't granted access to any
                home-screen actions yet. Ask them to add capabilities for you
                in the team server.
              </div>
            )
          }
          return <div className="setup-cards">{visibleCards}</div>
        })()}

        {showTeamProjects && teamSnapshot?.projects && (
          <TeamProjects
            projects={teamSnapshot.projects}
            onPick={(repoUrl, suggestedName) => {
              setShowTeamProjects(false)
              setUrl(repoUrl)
              setName(suggestedName)
              setMode('join')
            }}
            onClose={() => setShowTeamProjects(false)}
          />
        )}
        {showBrowse && orgConfigured && (
          <BrowseProjects
            org={orgConfigured}
            prefix={projectPrefix || undefined}
            onPick={(url, suggestedName) => {
              setShowBrowse(false)
              setUrl(url)
              setName(suggestedName)
              setMode('join')
            }}
            onClose={() => setShowBrowse(false)}
          />
        )}
        {/* GitHub auth row is only relevant when the user can create a
            project (which needs a GitHub identity to publish to). If
            their only caps are openProject / manufacturingView, hide
            the row — they don't need to think about GitHub auth. The
            recent-projects section below stays so they can re-enter
            already-cloned projects. */}
        {teamSnapshot?.enrolled && (
        <div className="setup-footer">
        {teamSnapshot.me?.capabilities.createProject && (
        <div className="setup-toolbar">
          <div className="setup-auth">
            {authStatus?.loggedIn ? (
              <>
                <span className="setup-auth-status">
                  ✓ Signed in to GitHub as <strong>{authStatus.username}</strong>
                </span>
                <button
                  className="toolbar-btn"
                  onClick={async () => {
                    setResetupMsg(null)
                    const r = await window.api.githubLogout()
                    if (r.success) {
                      setResetupMsg('Signed out of GitHub.')
                      refreshAuth()
                    } else {
                      setResetupMsg(r.error || 'Could not sign out.')
                    }
                  }}
                  title="Sign out of GitHub on this computer"
                >
                  Sign out
                </button>
              </>
            ) : signInPending ? (
              // Sign-in launched, waiting for the user to finish in the
              // browser/terminal. We auto-poll every 3s; the manual refresh
              // button is here as a fallback if polling misses.
              <>
                <span className="setup-auth-status muted">
                  Waiting for sign-in to complete…
                </span>
                <button
                  className="toolbar-btn"
                  onClick={refreshAuth}
                >
                  I signed in — refresh
                </button>
              </>
            ) : (
              <>
                <span className="setup-auth-status muted">
                  {authStatus?.ghCliAvailable === false
                    ? 'GitHub CLI not detected — install to enable sign-in'
                    : 'Not signed in to GitHub'}
                </span>
                <button
                  className="toolbar-btn primary"
                  onClick={handleGitHubLogin}
                  disabled={loggingIn || authStatus?.ghCliAvailable === false}
                >
                  {loggingIn ? 'Opening…' : 'Sign in with GitHub'}
                </button>
              </>
            )}
          </div>
          {resetupMsg && <div className="setup-toolbar-msg">{resetupMsg}</div>}
        </div>
        )}

        {recentProjects.length > 0 && (
          <div className="recent-projects">
            <h3>Recent Projects</h3>
            <div className="recent-list">
              {recentProjects.slice(0, 3).map(p => (
                <button
                  key={p.path}
                  className="recent-item"
                  onClick={() => onOpenProject(p.path)}
                  disabled={isLoading}
                >
                  <span className="recent-name">{p.name}</span>
                  <span className="recent-path">{p.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        </div>
        )}
      </div>
    )
  }

  if (mode === 'create') {
    return (
      <div className="setup-screen">
        <h1>Create Project</h1>
        <div className="setup-form">
          <div className="form-group">
            <label>Project Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="2026-Robot"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Location</label>
            <div className="path-input">
              <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Users\team2129\Documents" />
              <button className="browse-btn" onClick={handleBrowse}>Browse</button>
            </div>
          </div>
          <div className="form-group">
            <label>GitHub URL (optional)</label>
            <input
              value={remote}
              onChange={e => setRemote(e.target.value)}
              placeholder="https://github.com/frc2129/2026-robot.git"
            />
            {orgConfigured && projectPrefix && name && authStatus?.loggedIn && (
              <p className="admin-hint">
                Or click <strong>Create on GitHub</strong> to auto-create
                <code> {orgConfigured}/{projectPrefix}{name.replace(/[^a-zA-Z0-9._-]/g, '-')}</code>
                so other team members can find it via Browse.
              </p>
            )}
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={isCotsProject}
              onChange={e => setIsCotsProject(e.target.checked)}
            />
            <span>
              <strong>COTS library project</strong>
              <span className="checkbox-hint">Holds shared off-the-shelf parts. No part numbers will be assigned.</span>
            </span>
          </label>
          {createMsg && <div className="setup-toolbar-msg">{createMsg}</div>}
          <div className="form-actions">
            <button className="toolbar-btn" onClick={() => setMode('select')}>Back</button>
            {orgConfigured && projectPrefix && authStatus?.loggedIn && (
              <button
                className="toolbar-btn"
                disabled={!name || !path || isLoading || creatingOnGitHub}
                onClick={async () => {
                  setCreatingOnGitHub(true)
                  setCreateMsg(null)
                  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-')
                  const repoName = `${projectPrefix}${safeName}`
                  try {
                    const result = await window.api.createGitHubRepo(
                      orgConfigured, repoName, true, `FrameCAD project — ${name}`
                    )
                    if (!result.success || !result.url) {
                      setCreateMsg('✗ ' + (result.error || 'Could not create repo on GitHub'))
                      return
                    }
                    setCreateMsg(`✓ Created ${orgConfigured}/${repoName} — pushing local project...`)
                    await onCreateProject(name, `${path}/${name}`, result.url, isCotsProject)
                  } catch (err) {
                    setCreateMsg('✗ ' + (err as Error).message)
                  } finally {
                    setCreatingOnGitHub(false)
                  }
                }}
              >
                {creatingOnGitHub ? 'Creating on GitHub...' : 'Create on GitHub'}
              </button>
            )}
            <button
              className="toolbar-btn primary"
              disabled={!name || !path || isLoading}
              onClick={() => onCreateProject(name, `${path}/${name}`, remote, isCotsProject)}
            >
              {isLoading ? <span className="loading-spinner" /> : 'Create'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'join') {
    return (
      <div className="setup-screen">
        <h1>Join Project</h1>
        <div className="setup-form">
          <div className="form-group">
            <label>GitHub URL</label>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://github.com/frc2129/2026-robot.git"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Save To</label>
            <div className="path-input">
              <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Users\team2129\Documents" />
              <button className="browse-btn" onClick={handleBrowse}>Browse</button>
            </div>
          </div>
          <div className="form-actions">
            <button className="toolbar-btn" onClick={() => setMode('select')}>Back</button>
            <button
              className="toolbar-btn primary"
              disabled={!url || !path || isLoading}
              onClick={() => onJoinProject(url, path)}
            >
              {isLoading ? <span className="loading-spinner" /> : 'Join'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="setup-screen">
      <h1>Open Project</h1>
      <p className="subtitle">Pick a recent project, or browse for a folder.</p>
      <div className="open-projects">
        {pinnedProjects.length > 0 && (
          <div className="open-projects-section">
            <div className="open-projects-section-label">Pinned</div>
            {pinnedProjects.map(p => (
              <ProjectRow
                key={p.path}
                project={p}
                disabled={isLoading}
                onOpen={() => onOpenProject(p.path)}
                onTogglePin={() => togglePin(p)}
                onRemove={() => removeFromRecent(p)}
              />
            ))}
          </div>
        )}
        {unpinnedProjects.length > 0 && (
          <div className="open-projects-section">
            <div className="open-projects-section-label">Recent</div>
            {unpinnedProjects.map(p => (
              <ProjectRow
                key={p.path}
                project={p}
                disabled={isLoading}
                onOpen={() => onOpenProject(p.path)}
                onTogglePin={() => togglePin(p)}
                onRemove={() => removeFromRecent(p)}
              />
            ))}
          </div>
        )}
        {recentProjects.length === 0 && (
          <div className="open-projects-empty">
            No recent projects yet. Browse for a folder below to open one.
          </div>
        )}
        <button
          className="open-projects-browse"
          onClick={handleBrowseAndOpen}
          disabled={isLoading}
        >
          <FolderOpen size={18} strokeWidth={1.75} />
          <span>Browse for a project folder…</span>
        </button>
      </div>
      <div className="form-actions">
        <button className="toolbar-btn" onClick={() => setMode('select')}>Back</button>
      </div>
    </div>
  )
}

interface ProjectRowProps {
  project: ProjectConfig
  disabled: boolean
  onOpen: () => void
  onTogglePin: () => void
  onRemove: () => void
}

function ProjectRow({ project, disabled, onOpen, onTogglePin, onRemove }: ProjectRowProps) {
  return (
    <div className="open-project-row">
      <button
        className="open-project-main"
        onClick={onOpen}
        disabled={disabled}
        title={project.path}
      >
        <span className="open-project-name">{project.name}</span>
        <span className="open-project-path">{project.path}</span>
      </button>
      <button
        className="open-project-action"
        onClick={onTogglePin}
        title={project.pinned ? 'Unpin' : 'Pin to top'}
      >
        {project.pinned
          ? <PinOff size={14} strokeWidth={1.75} />
          : <Pin size={14} strokeWidth={1.75} />}
      </button>
      <button
        className="open-project-action"
        onClick={onRemove}
        title="Remove from list"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
