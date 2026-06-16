import { useState, useEffect, useCallback, useRef } from 'react'
import { Factory, Settings, UserPlus, HardDrive, Bug } from 'lucide-react'
import logoUrl from '../assets/logo.png'
import TeamEnroll from './TeamEnroll'
import DriveJoin from './DriveJoin'
import { prepareSlamSnapshot, triggerWaterSlam } from '../lib/water-slam'
import type { GlobalAdminConfig, ProjectConfig, TeamSnapshot } from '@shared/types'

interface Props {
  /** Download + open a Google Drive project. Drives the Drive-backend
   *  join flow (sign in → pick Shared Drive + folder → download). */
  onJoinDriveProject: (args: {
    folderId: string
    sharedDriveId: string
    localPath: string
    name: string
  }) => Promise<void>
  onOpenProject: (path: string) => Promise<boolean>
  /** Open a project and jump straight into the Manufacturing View
   *  (shop-floor mode). Disabled when there are no recent projects to
   *  open. */
  onEnterManufacturingView?: () => void
  onOpenAdmin?: () => void
  isLoading: boolean
  /**
   * Install-wide admin settings. Used for the team name in the header.
   */
  globalAdmin?: GlobalAdminConfig
  /** Team-server snapshot from App level — drives the welcome-screen
   *  enrollment prompt and the project list. */
  teamSnapshot: TeamSnapshot | null
  /** Force a fresh fetch from the team server (e.g. after enrollment). */
  onTeamRefresh?: () => Promise<void>
}

/**
 * Three modes left after the Google Drive backend rewrite:
 *  - `select`: the home view. Unenrolled → Sync-with-Team card. Enrolled
 *    → the list of team projects (informational) + your downloaded Drive
 *    projects + the "Join from Google Drive" entry point. Project
 *    creation lives entirely in the server admin UI.
 *  - `enroll`: paste server URL + PIN via TeamEnroll component.
 *  - `drive`: sign in to Google, pick a Shared Drive + folder, download.
 */
type Mode = 'select' | 'enroll' | 'drive'

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

export default function ProjectSetup({ onJoinDriveProject, onOpenProject, onEnterManufacturingView, onOpenAdmin, isLoading, globalAdmin, teamSnapshot, onTeamRefresh }: Props) {
  const [mode, setMode] = useState<Mode>('select')
  // When the user clicks a not-yet-downloaded team project, jump into the
  // Drive join flow pre-targeted at that project's Shared Drive + folder
  // (they only pick a save path). Null = generic "Join from Google Drive".
  const [joinTarget, setJoinTarget] = useState<{ sharedDriveId: string; folderId: string; name: string } | null>(null)
  // Local clones — used to enable the Manufacturing View button (which
  // needs at least one local project) and to surface already-downloaded
  // Google Drive projects so they can be reopened.
  const [recentProjects, setRecentProjects] = useState<ProjectConfig[]>([])

  useEffect(() => {
    window.api.getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  // Google Drive sign-in status. Opening an already-downloaded project talks
  // to Drive (sync / publish / locks, plus a legacy-manifest name back-fill),
  // so a not-signed-in open dead-ends in a confusing "isn't a FrameCAD
  // project" error. We grey out the local-open rows on this and offer an
  // inline sign-in instead. null = still checking → treated as unlocked so the
  // rows don't flash disabled on load.
  const [googleSignedIn, setGoogleSignedIn] = useState<boolean | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const refreshGoogleStatus = useCallback(() => {
    window.api.googleAuthStatus()
      .then(s => setGoogleSignedIn(!!s.signedIn))
      .catch(() => setGoogleSignedIn(false))
  }, [])
  useEffect(() => { refreshGoogleStatus() }, [refreshGoogleStatus])
  // Re-check on returning to the home view — a DriveJoin sign-in (or a
  // Settings sign-out) may have flipped it while we were away.
  useEffect(() => {
    if (mode === 'select') refreshGoogleStatus()
  }, [mode, refreshGoogleStatus])

  const signInToGoogle = useCallback(async () => {
    setSigningIn(true)
    try {
      const s = await window.api.googleSignIn()
      setGoogleSignedIn(!!s.signedIn)
    } catch {
      // user closed the consent window / denied — leave it locked
    } finally {
      setSigningIn(false)
    }
  }, [])

  // Local (already-downloaded) projects can only be opened once Google Drive
  // is connected. Download / Join rows are exempt — DriveJoin signs in itself.
  const driveLocked = googleSignedIn === false

  // Welcome-screen "report an issue" reminder + inline form. Reports go to the
  // team server's admin Reports page (same pipe as the error-banner Report
  // button), so the admin sees problems fast instead of hearing them in person.
  const [reportOpen, setReportOpen] = useState(false)
  const [reportText, setReportText] = useState('')
  const [reportState, setReportState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [reportResult, setReportResult] = useState<{ id?: number; error?: string }>({})

  const submitReport = useCallback(async () => {
    const text = reportText.trim()
    if (!text) return
    setReportState('sending')
    try {
      const r = await window.api.reportIssue(text)
      if (r.success) {
        setReportResult({ id: r.id })
        setReportState('sent')
        setReportText('')
      } else {
        setReportResult({ error: r.error || 'Could not send' })
        setReportState('failed')
      }
    } catch (err) {
      setReportResult({ error: (err as Error).message })
      setReportState('failed')
    }
  }, [reportText])

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
  // The member's auto-open/kiosk target. Setting one is an explicit admin
  // statement that this member belongs in that project, so it stays
  // visible and joinable even without the broader Team Projects capability
  // — otherwise a kiosk/auto-open member on a fresh install dead-ends on
  // an empty welcome screen with no way to download their one project.
  const autoOpenTarget = (teamSnapshot?.me?.autoOpenProjectId != null)
    ? (teamSnapshot?.projects ?? []).find(p => p.id === teamSnapshot!.me!.autoOpenProjectId)
    : undefined
  // Gate on browseTeamProjects — the ONE project capability the admin web
  // UI exposes ("Team Projects: lets them see and join projects registered
  // in this server"). It used to require `openProject`, which the admin UI
  // deliberately hides as a legacy no-op — so an admin who ticked Team
  // Projects + set the allowlist still saw every join refused with
  // "your admin has not granted you access".
  const canJoinDrive =
    !!teamSnapshot?.enrolled &&
    (!!teamSnapshot.me?.capabilities?.browseTeamProjects || !!autoOpenTarget) &&
    (
      teamSnapshot.me?.role !== 'student' ||
      // A folder id alone is enough — DriveJoin resolves the containing
      // Shared Drive when the registry row never recorded one.
      (teamSnapshot.projects?.some(p => !!p.driveFolderId) ?? false)
    )
  const serverProjectByDriveId = new Map(
    (teamSnapshot?.projects ?? [])
      .filter(p => !!p.driveFolderId)
      .map(p => [p.driveFolderId!, p])
  )
  const localDriveProjects = recentProjects
    .filter(p => p.backend === 'drive')
    .filter(p => teamSnapshot?.me?.role !== 'student' || (!!p.driveFolderId && serverProjectByDriveId.has(p.driveFolderId)))
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

    // The slam impact is what "unlocks" the session-persistent
    // click-wave ripples (see installClickWaves above).
    installClickWaves()
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
        globalAdmin={globalAdmin}
      />
    )
  }

  if (mode === 'drive') {
    if (!canJoinDrive) {
      return (
        <div className="setup-screen">
          <h1>Join from Google Drive</h1>
          <div className="setup-form">
            <p className="form-hint">
              Your admin has not granted you access to join any Drive projects.
            </p>
            <div className="form-actions">
              <button className="toolbar-btn" onClick={() => { setMode('select'); setJoinTarget(null) }}>Back</button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <DriveJoin
        onBack={() => { setMode('select'); setJoinTarget(null) }}
        onJoinDriveProject={onJoinDriveProject}
        isLoading={isLoading}
        allowedProjects={teamSnapshot?.projects ?? []}
        allowAllProjects={teamSnapshot?.me?.role !== 'student'}
        initialTarget={joinTarget}
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
        {/* Unenrolled: a single Sync-with-Team card. Project creation
            and listing are server-owned now; nothing else makes sense
            before the device is paired with a team. */}
        {!teamSnapshot?.enrolled && (
          <div className="setup-cards setup-cards-team">
            <button className="setup-card" onClick={() => setMode('enroll')}>
              <span className="card-icon"><UserPlus size={32} strokeWidth={1.5} /></span>
              <span className="card-title">Sync with Team</span>
              <span className="card-desc">
                Enter a PIN from your<br />team's admin
              </span>
            </button>
          </div>
        )}

        {/* Not signed in to Google Drive → opening a downloaded project would
            fail. Surface a clear sign-in prompt and grey out the local-open
            rows below until it's connected. */}
        {teamSnapshot?.enrolled && driveLocked && (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 12, flexWrap: 'wrap', margin: '20px auto 0', padding: '12px 16px',
              border: '1px solid var(--border, rgba(255,255,255,0.12))', borderRadius: 8,
              background: 'var(--overlay-0, rgba(255,255,255,0.03))', maxWidth: 520
            }}
          >
            <span style={{ fontSize: 13, opacity: 0.9 }}>
              <HardDrive size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Sign in to Google Drive to open your projects.
            </span>
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={signInToGoogle}
              disabled={signingIn}
            >
              {signingIn ? 'Opening Google…' : 'Sign in with Google'}
            </button>
          </div>
        )}

        {/* Enrolled: render the list of projects the team server has
            granted this member access to. This is INFORMATIONAL only —
            joining a project happens through "Join from Google Drive"
            below (the bytes live on the team's Shared Drive). The team
            server already enforces the per-member project allowlist
            server-side (see server/src/routes/client.ts `/api/projects`),
            so we don't filter again here. */}
        {teamSnapshot?.enrolled && (() => {
          const caps = teamSnapshot.me?.capabilities
          // No browse capability → empty state with the same copy
          // we use when the project list IS available but happens
          // to be empty. EXCEPT when the admin set an auto-open/kiosk
          // target: that's an explicit "this member belongs in that
          // project", so show that one row (it must be downloadable on
          // a fresh install or the kiosk dead-ends). The server filters
          // /api/projects to honor the per-member allowlist; this is
          // the client-side capability gate that controls whether the
          // LIST itself is visible.
          if (!caps?.browseTeamProjects && !autoOpenTarget) {
            return (
              <div
                className="setup-cards-empty hint"
                style={{ textAlign: 'center', marginTop: 24, opacity: 0.8 }}
              >
                Your admin hasn't given you access to browse team
                projects yet. Ask them to enable Team Projects for you
                on the server.
              </div>
            )
          }
          const projects = caps?.browseTeamProjects
            ? (teamSnapshot.projects ?? [])
            : [autoOpenTarget!]
          if (projects.length === 0) {
            return (
              <div
                className="setup-cards-empty hint"
                style={{ textAlign: 'center', marginTop: 24, opacity: 0.8 }}
              >
                Your admin hasn't given you access to any projects yet.
                Ask them to add you to a project on the team server.
              </div>
            )
          }
          return (
            <div className="project-list">
              {projects.map(p => {
                const local = p.driveFolderId
                  ? recentProjects.find(r => r.backend === 'drive' && r.driveFolderId === p.driveFolderId)
                  : undefined
                // A not-yet-downloaded project is joinable when the server
                // recorded its Drive folder — clicking it starts a
                // pre-targeted download instead of being a dead row. A
                // missing sharedDriveId (rows registered before that column
                // existed, or with the optional field left blank) is fine:
                // DriveJoin resolves the containing Shared Drive from the
                // folder id itself.
                const joinable = !local && !!p.driveFolderId
                const interactive = !!local || joinable
                // A downloaded project can't be opened until Google Drive is
                // connected; the download/join rows are exempt (DriveJoin signs
                // in itself).
                const localLocked = !!local && driveLocked
                const RowTag = interactive ? 'button' : 'div'
                return (
                <RowTag
                  key={p.id}
                  type={interactive ? 'button' : undefined}
                  className={'project-list-row' + (interactive ? '' : ' project-list-row-static')}
                  title={localLocked ? 'Sign in to Google Drive to open this project' : local ? local.path : joinable ? `Download “${p.name}” from Google Drive` : 'Not available to join yet — your admin hasn’t recorded this project’s Google Drive folder ID on the team server.'}
                  disabled={interactive ? (isLoading || localLocked) : undefined}
                  onClick={
                    localLocked
                      ? undefined
                      : local
                        ? () => onOpenProject(local.path)
                        : joinable
                          ? () => {
                              setJoinTarget({ sharedDriveId: p.sharedDriveId ?? '', folderId: p.driveFolderId!, name: p.name })
                              setMode('drive')
                            }
                          : undefined
                  }
                >
                  <div className="project-list-row-main">
                    <div className="project-list-row-name">{p.name}</div>
                    {local ? (
                      <div className="project-list-row-path" title={local.path}>{local.path}</div>
                    ) : p.description && (
                      <div className="project-list-row-desc">{p.description}</div>
                    )}
                  </div>
                  <div className="project-list-row-status">
                    <span className={'pill ' + (local ? 'pill-local' : 'pill-remote')}>
                      {local ? '✓ Local' : joinable ? '↓ Download' : 'Google Drive'}
                    </span>
                  </div>
                </RowTag>
              )})}
            </div>
          )
        })()}

        {/* Manufacturing View — secondary action. Quieter outline
            button under the project list so it doesn't compete with
            the projects themselves. Mentors+ always have it; students
            via the manufacturingView capability (same rule as the
            in-project Shop tab). Disabled when there are no local
            clones — the shop-floor view lives INSIDE a project. */}
        {teamSnapshot?.enrolled
          && (teamSnapshot.me?.role !== 'student' || teamSnapshot.me?.capabilities?.manufacturingView)
          && onEnterManufacturingView && (
          <div className="setup-mfg-row">
            <button
              type="button"
              className="setup-mfg-button"
              onClick={() => onEnterManufacturingView?.()}
              disabled={recentProjects.length === 0 || driveLocked}
              title={driveLocked
                ? 'Sign in to Google Drive first'
                : recentProjects.length === 0
                  ? 'Open a project first — the manufacturing queue lives inside a project'
                  : 'Shop-floor view: just what needs to be made'}
            >
              <Factory size={14} strokeWidth={1.75} />
              <span>Manufacturing View</span>
            </button>
          </div>
        )}

        {/* Locally-downloaded Google Drive projects. Matched server projects
            are opened from the Team Projects list above; this section catches
            local Drive clones that are not in the current server snapshot
            (for mentors/admins, old projects, or standalone/local recovery). */}
        {(() => {
          const driveProjects = localDriveProjects.filter(p =>
            !p.driveFolderId || !serverProjectByDriveId.has(p.driveFolderId)
          )
          if (driveProjects.length === 0) return null
          return (
            <div className="project-list" style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, margin: '0 0 6px 2px' }}>
                Your Google Drive projects
              </div>
              {driveProjects.map(p => (
                <button
                  key={p.path}
                  type="button"
                  className="project-list-row"
                  disabled={isLoading || driveLocked}
                  title={driveLocked ? 'Sign in to Google Drive to open this project' : p.path}
                  onClick={driveLocked ? undefined : () => onOpenProject(p.path)}
                >
                  <div className="project-list-row-main">
                    <div className="project-list-row-name">
                      <HardDrive size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                      {p.name}
                    </div>
                    <div className="project-list-row-path" title={p.path}>{p.path}</div>
                  </div>
                  <div className="project-list-row-status">
                    <span className="pill pill-local">✓ Local</span>
                  </div>
                </button>
              ))}
            </div>
          )
        })()}

        {/* Google Drive backend — the primary (and only) way to join a
            project. Requires team enrollment because Drive check-out /
            check-in locks use the team server identity. */}
        {canJoinDrive && (
          <div className="setup-cards" style={{ marginTop: 20 }}>
            <button
              className="setup-card"
              onClick={() => setMode('drive')}
              title="Join a project stored on your team's Google Shared Drive"
            >
              <span className="card-icon"><HardDrive size={32} strokeWidth={1.5} /></span>
              <span className="card-title">Join from Google Drive</span>
              <span className="card-desc">
                Pick a project from your<br />team's Shared Drive
              </span>
            </button>
          </div>
        )}

        {/* Issue-report reminder. Only meaningful once enrolled — reports go to
            the team server's admin Reports page. Collapsed to a one-line nudge;
            expands to a small form so a report is two clicks away from anywhere
            on the home screen. */}
        {teamSnapshot?.enrolled && (
          <div className="setup-report-note" style={{ marginTop: 28, textAlign: 'center', fontSize: 13 }}>
            {!reportOpen ? (
              <span style={{ opacity: 0.85 }}>
                <Bug size={13} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Something broken or not working right?{' '}
                <button
                  type="button"
                  onClick={() => { setReportOpen(true); setReportState('idle'); setReportResult({}) }}
                  style={{ background: 'none', border: 'none', color: 'var(--accent, #7c5cff)', cursor: 'pointer', textDecoration: 'underline', font: 'inherit', padding: 0 }}
                >
                  Report an issue
                </button>{' '}
                so we can fix it fast.
              </span>
            ) : (
              <div style={{ maxWidth: 460, margin: '0 auto', textAlign: 'left' }}>
                <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>Describe the issue</label>
                <textarea
                  value={reportText}
                  onChange={e => setReportText(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="What happened, and what were you doing when it broke?"
                  style={{ width: '100%', marginTop: 4, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="toolbar-btn primary"
                    onClick={submitReport}
                    disabled={reportState === 'sending' || !reportText.trim()}
                  >
                    {reportState === 'sending' ? 'Sending…' : 'Send to admin'}
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={() => { setReportOpen(false); setReportState('idle') }}
                  >
                    {reportState === 'sent' ? 'Close' : 'Cancel'}
                  </button>
                  {reportState === 'sent' && (
                    <span style={{ color: 'var(--green, #16a34a)' }}>
                      {reportResult.id ? `✓ Sent — report #${reportResult.id}` : '✓ Sent'}
                    </span>
                  )}
                  {reportState === 'failed' && (
                    <span style={{ color: 'var(--red, #ef4444)' }} title={reportResult.error}>
                      Couldn't send — {reportResult.error}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // No other modes are reachable — `Mode` is narrowed to the cases
  // handled above. This unreachable return keeps the function total
  // without firing a runtime branch.
  return null
}
