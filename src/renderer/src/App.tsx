import { useMemo, useState, useEffect, useCallback, useRef, type JSX } from 'react'
import { ChevronLeft, Sun, Moon, X } from 'lucide-react'
import ErrorMsg from './components/ErrorMsg'
import { useGit } from './hooks/useGit'
import useLayoutTier from './hooks/useLayoutTier'
import { DEFAULT_MATERIALS, DEFAULT_MATERIALS_DATALIST_ID } from './constants'
import useParts from './hooks/useParts'
import ProjectSetup from './components/ProjectSetup'
import ProjectBrowser from './components/ProjectBrowser'
import Toolbar from './components/Toolbar'
import DetailsPanel from './components/DetailsPanel'
import AdminPage from './components/AdminPage'
import ManufacturingQueue from './components/ManufacturingQueue'
import { useApiBusy } from './hooks/useApiBusy'
import ManufacturingModeShell from './components/ManufacturingModeShell'
import OnboardingTour from './components/OnboardingTour'
import ArchiveDashboard from './components/ArchiveDashboard'
import Sidebar, { type SidebarSection } from './components/Sidebar'
import ActivityView from './components/ActivityView'
import PartsManager from './components/PartsManager'
import ApprovalsPanel from './components/ApprovalsPanel'
import logoUrl from './assets/logo.png'
import type { AdminConfig, FileEntry, GlobalAdminConfig, ProjectTotals, PublishProgress, UpdateInfo, UpdateRetryStatus } from '@shared/types'
import { useTeam } from './hooks/useTeam'

function countByState(files: FileEntry[], state: string): number {
  let count = 0
  for (const f of files) {
    if (!f.isDirectory && f.state === state) count++
    if (f.children) count += countByState(f.children, state)
  }
  return count
}

// One-shot rename of localStorage keys from the legacy trentcad-* prefix
// to framecad-*. Runs at module import, before any useState initializer
// reads from localStorage, so users coming from older builds keep their
// theme, dyslexic-font toggle, onboarding-seen flag, and admin unlock.
;(() => {
  const legacyKeys = [
    'onboarding-seen',
    'theme',
    'dyslexic-font'
  ]
  for (const k of legacyKeys) {
    const oldKey = `trentcad-${k}`
    const newKey = `framecad-${k}`
    if (localStorage.getItem(newKey) !== null) continue
    const v = localStorage.getItem(oldKey)
    if (v === null) continue
    localStorage.setItem(newKey, v)
    localStorage.removeItem(oldKey)
  }
})()

export default function App() {
  const {
    project,
    files,
    history,
    locks,
    isLoading,
    error,
    selectedFile,
    setSelectedFile,
    joinDriveProject,
    openProject,
    closeProject,
    sync,
    publish,
    checkOut,
    checkIn,
    createNewPart,
    createNewAssembly,
    createSubsystem,
    dismissError,
    setError
  } = useGit()

  const [identityChecked, setIdentityChecked] = useState(false)
  const [gitName, setGitName] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [updateRetry, setUpdateRetry] = useState<UpdateRetryStatus | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string>('')
  const [adminConfig, setAdminConfig] = useState<AdminConfig>({})
  const [globalAdmin, setGlobalAdmin] = useState<GlobalAdminConfig>({})

  // Team-server snapshot, push-subscribed from main. `snapshot` is null
  // until the first IPC primes the cache (sub-50ms); subsequent updates
  // arrive via push from main.
  const team = useTeam()
  const teamSnapshot = team.snapshot

  const [localGlobalAdmin, setLocalGlobalAdmin] = useState<GlobalAdminConfig>({})
  const refreshGlobalAdmin = useCallback(() => {
    window.api.getGlobalAdmin()
      .then(state => setLocalGlobalAdmin(state.effective))
      .catch(() => {})
  }, [])

  // Server-side team config takes priority over per-machine defaults
  // once the user is enrolled with a team.
  useEffect(() => {
    if (teamSnapshot?.enrolled && teamSnapshot.team) {
      setGlobalAdmin({
        teamName: teamSnapshot.team.name || localGlobalAdmin.teamName,
        welcomeMessage: teamSnapshot.team.welcomeMessage || localGlobalAdmin.welcomeMessage,
        gitHubOrg: teamSnapshot.team.gitHubOrg || localGlobalAdmin.gitHubOrg,
        projectPrefix: teamSnapshot.team.projectPrefix || localGlobalAdmin.projectPrefix,
      })
    } else {
      setGlobalAdmin(localGlobalAdmin)
    }
  }, [teamSnapshot, localGlobalAdmin])

  const [showAdmin, setShowAdmin] = useState(false)

  // Sidebar navigation (project view)
  const [activeSection, setActiveSection] = useState<SidebarSection>('files')
  const [inspectorOpen, setInspectorOpen] = useState(true)

  // Track viewport tier so the inspector can be rendered inline on
  // wide screens and as an overlay on narrow ones, and the sidebar
  // can collapse to icons-only when there's no room for labels.
  const layoutTier = useLayoutTier()
  useEffect(() => {
    document.documentElement.dataset.layoutTier = layoutTier
    return () => { delete document.documentElement.dataset.layoutTier }
  }, [layoutTier])

  // On overlay tiers, re-open the inspector whenever the user selects a
  // file so they don't have to manually re-open the panel after
  // dismissing it once. On the wide tier the inspector stays put.
  const prevSelectedPathRef = useRef<string | null>(selectedFile?.path ?? null)
  useEffect(() => {
    const next = selectedFile?.path ?? null
    if (next && next !== prevSelectedPathRef.current && layoutTier !== 'wide') {
      setInspectorOpen(true)
    }
    prevSelectedPathRef.current = next
  }, [selectedFile, layoutTier])

  const [manufacturingView, setManufacturingView] = useState(false)

  // Reset manufacturingView only when an *open* project gets closed
  // (project transitions truthy → falsy). NOT on the transient null→set
  // case where the user just clicked "Enter Manufacturing View" — there
  // manufacturingView is set first so the kiosk shell takes over the
  // moment openProject resolves, without flashing the regular project
  // view in between.
  const prevProjectRef = useRef(project)
  useEffect(() => {
    if (manufacturingView && prevProjectRef.current && !project) {
      setManufacturingView(false)
    }
    prevProjectRef.current = project
  }, [manufacturingView, project])

  const [reportState, setReportState] = useState<'idle' | 'confirm' | 'sending' | 'sent' | 'failed'>('idle')
  const [reportResult, setReportResult] = useState<{ id?: number; error?: string }>({})

  useEffect(() => {
    setReportState('idle')
    setReportResult({})
  }, [error])

  const submitReport = useCallback(async () => {
    if (!error) return
    setReportState('sending')
    try {
      const r = await window.api.reportIssue(error)
      if (r.success) {
        setReportResult({ id: r.id })
        setReportState('sent')
      } else {
        setReportResult({ error: r.error || 'Unknown error' })
        setReportState('failed')
      }
    } catch (err) {
      setReportResult({ error: (err as Error).message })
      setReportState('failed')
    }
  }, [error])

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)

  useEffect(() => {
    const goOnline = () => setOffline(false)
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    if (!localStorage.getItem('framecad-onboarding-seen')) {
      setShowOnboarding(true)
    }
  }, [])

  // ── Emergency: release from team management ────────────────────────
  // Hidden hotkey for the worst case where the team server is gone
  // forever (decommissioned, school's IT wiped the box, etc.) and a
  // kiosk-mode client is locked into a project it can't sync. The
  // normal Sign Out path lives in the AdminPage settings overlay,
  // which kiosk users can't reach. Ctrl+Shift+Alt+R fires here
  // regardless of where they are in the UI.
  //
  // Deliberately obscure 4-key chord — a kid leaning on the keyboard
  // can't hit it accidentally. teamSignOut() already tolerates a
  // dead server (3-second DELETE timeout, errors swallowed) so this
  // works even when nothing on the network responds.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'r')) return
      e.preventDefault()
      const ok = window.confirm(
        'Release this device from team management?\n\n' +
        'Only do this if your team server is permanently gone. ' +
        'The device will lose all team-server settings (project ' +
        'list, capabilities, kiosk mode) and the welcome screen ' +
        'will reappear so you can enroll with a different server.',
      )
      if (!ok) return
      void window.api.teamSignOut().catch(() => {
        // signOut catches its own network errors but defend
        // against any future regression here too.
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Auto-open / kiosk mode ─────────────────────────────────────────
  // Two related behaviours sharing the same effect:
  //
  // 1. autoOpenProjectId only (kioskMode=false): SOFT hint. Auto-open
  //    the matched project once per launch. Closing returns to the
  //    welcome screen for the rest of the session — the per-target
  //    guard prevents a reopen loop.
  //
  // 2. autoOpenProjectId + kioskMode=true: HARD lockdown. The user is
  //    locked into the project. Closing it re-opens immediately,
  //    welcome screen is never shown. The guard is bypassed so the
  //    effect fires every time `project` goes null.
  //
  // We track the last-attempted target (not just a boolean) so that
  // when the admin reassigns the kiosk to a different project mid-
  // session, the auto-open fires again for the new target. Using
  // useState (not useRef) also means the kiosk-stuck banner picks up
  // the transition on the very next render — refs don't trigger one,
  // so the banner used to need an unrelated state change to appear.
  const [autoOpenAttempted, setAutoOpenAttempted] = useState<number | null>(null)
  const kioskMode = !!teamSnapshot?.me?.kioskMode
  // Archive devices are read-only mirrors with their own dedicated screen —
  // they never open a project for editing, so auto-open/kiosk don't apply.
  const archiveMode = !!teamSnapshot?.me?.archiveMode
  useEffect(() => {
    if (archiveMode) return                      // archive box never auto-opens
    if (project) return                          // already in a project
    if (team.loading) return                     // wait for snapshot
    const target = teamSnapshot?.me?.autoOpenProjectId ?? null
    if (target === null) return
    // Non-kiosk: don't re-attempt the same target this session, but
    // DO retry if the admin reassigned to a different project.
    if (!kioskMode && autoOpenAttempted === target) return
    const projectEntry = teamSnapshot?.projects?.find(p => p.id === target)
    if (!projectEntry) return
    setAutoOpenAttempted(target)
    void (async () => {
      try {
        const recents = await window.api.getRecentProjects()
        // Match a downloaded project to the auto-open target by Drive folder id
        // first (Drive recents have no GitHub remote), then fall back to the
        // legacy GitHub remote match.
        const match = recents.find(r =>
          (projectEntry.driveFolderId && r.driveFolderId === projectEntry.driveFolderId) ||
          (r.remote && r.remote === projectEntry.repoUrl)
        )
        if (match) await openProject(match.path)
        // No local clone yet — gracefully fall through to the welcome
        // screen so the user (or admin) can pick "Team Projects" and
        // clone it the first time. Once cloned and reopened it'll be
        // in `recents` for next launch and the auto-open kicks in.
        // In kiosk mode the welcome screen IS still shown in this
        // edge case so the operator can finish first-time setup; the
        // alternative is a blank window with no recovery path.
      } catch { /* let the welcome screen surface the issue */ }
    })()
  }, [teamSnapshot, team.loading, project, openProject, kioskMode, archiveMode, autoOpenAttempted])

  const dismissOnboarding = useCallback(() => {
    localStorage.setItem('framecad-onboarding-seen', '1')
    setShowOnboarding(false)
  }, [])

  const [publishProgress, setPublishProgress] = useState<PublishProgress | null>(null)
  const [progressHidden, setProgressHidden] = useState(false)
  const [progressKind, setProgressKind] = useState<'publish' | 'join'>('publish')
  const [projectTotals, setProjectTotals] = useState<ProjectTotals | null>(null)

  // Hold the auto-dismiss timer for the `done` phase in a ref so the
  // next progress event (or unmount) can cancel it. Without that, a
  // rapid re-publish during the 2-second auto-dismiss window would
  // get its first 'preparing' event wiped by the still-pending timer.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // Within a single phase, progress events can carry different field
    // subsets (e.g. one event sets percent, another sets detail). Plain
    // `setPublishProgress(p)` would let a partial event wipe out
    // percent/files/detail set by an earlier one. Shallow-merge within
    // the same phase preserves each event's contribution; phase change
    // still discards (the 'preparing' detail shouldn't bleed into
    // 'uploading').
    const merge = (p: PublishProgress) => (prev: PublishProgress | null): PublishProgress => {
      if (!prev || prev.phase !== p.phase) return p
      return { ...prev, ...p }
    }
    const cancelDismiss = (): void => {
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
    }
    const cleanupPublish = window.api.onPublishProgress((p) => {
      cancelDismiss()
      // If we were showing a join progress modal, discard its stale
      // fields (files list, percent) before the publish takes over —
      // otherwise the modal briefly shows join data attributed to a
      // publish event because of the shallow merge.
      setProgressKind(prev => {
        if (prev !== 'publish') setPublishProgress(null)
        return 'publish'
      })
      setPublishProgress(merge(p))
      if (p.phase === 'error' || p.phase === 'preparing') {
        setProgressHidden(false)
      }
      if (p.phase === 'done') {
        dismissTimerRef.current = setTimeout(() => {
          dismissTimerRef.current = null
          setPublishProgress(null)
          setProgressHidden(false)
        }, 2000)
      }
    })
    const cleanupJoin = window.api.onJoinProgress((p) => {
      cancelDismiss()
      setProgressKind(prev => {
        if (prev !== 'join') setPublishProgress(null)
        return 'join'
      })
      setPublishProgress(merge(p))
      if (p.phase === 'error' || p.phase === 'preparing') {
        setProgressHidden(false)
      }
      if (p.phase === 'done') {
        dismissTimerRef.current = setTimeout(() => {
          dismissTimerRef.current = null
          setPublishProgress(null)
          setProgressHidden(false)
        }, 2000)
      }
    })
    return () => {
      cleanupPublish()
      cleanupJoin()
      cancelDismiss()
    }
  }, [])

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  const refreshAdminConfig = useCallback(() => {
    if (!project) {
      setAdminConfig({})
      return
    }
    window.api.getAdminConfig().then(c => setAdminConfig(c || {})).catch(() => {})
  }, [project])

  useEffect(() => {
    refreshAdminConfig()
  }, [refreshAdminConfig])

  useEffect(() => {
    refreshGlobalAdmin()
  }, [refreshGlobalAdmin])

  useEffect(() => {
    if (!project) {
      setProjectTotals(null)
      return
    }
    const refresh = () =>
      window.api.getProjectTotals().then(setProjectTotals).catch(() => setProjectTotals(null))
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [project])

  // Team-server reachability dot. Polled on a slow cadence (30s)
  // because it's a network round-trip — fast enough that a flaky
  // school WiFi shows up within a typical CAD session, slow enough
  // that the constant pulse doesn't waste packets. 'unknown' is the
  // pre-first-result state so we don't render a misleading red dot
  // before the first ping completes.
  const [serverReach, setServerReach] = useState<
    'unknown' | 'reachable' | 'unreachable' | 'not-enrolled'
  >('unknown')
  useEffect(() => {
    let cancelled = false
    const ping = () => {
      window.api.teamPingServer()
        .then(s => { if (!cancelled) setServerReach(s) })
        .catch(() => { if (!cancelled) setServerReach('unreachable') })
    }
    ping()
    const id = setInterval(ping, 30000)
    return () => { cancelled = true; clearInterval(id) }
  }, [teamSnapshot?.enrolled])

  // Role tiers — `isAdmin` ⊇ `isMentor` ⊇ student. Standalone mode
  // (not enrolled with a team server) grants full admin so solo users
  // aren't locked out of their own app. Once enrolled, the roles come
  // from the team server's snapshot.
  // While the team snapshot is still priming (snapshot===null right
  // after window mount), treat the user as enrolled / lowest-privilege
  // so we don't briefly flash the standalone-admin UI to someone who
  // has a persisted enrollment. Once the snapshot lands, the real
  // values take over via the next render.
  const enrolled = team.loading ? true : !!teamSnapshot?.enrolled
  const myRole = teamSnapshot?.me?.role ?? null
  // A device the server REVOKED (401) is un-enrolled but must NOT get the
  // standalone-admin grant — otherwise a removed/demoted student flips to full
  // admin UI on a shared machine. Standalone-admin is only for genuinely
  // never-enrolled solo users.
  const revoked = !!teamSnapshot?.revoked
  const isAdmin = team.loading ? false : ((!enrolled && !revoked) || myRole === 'admin')
  const isMentor = team.loading ? false : (isAdmin || myRole === 'mentor')
  // "Trusted student" CAD-structure power (goal 7): mentors/admins always have
  // it; a student gets it via the server-granted manageCadStructure capability.
  const canManageCad = isMentor || !!teamSnapshot?.me?.capabilities?.manageCadStructure
  const canForceCheckIn = isMentor || !!teamSnapshot?.me?.capabilities?.forceCheckIn

  // If a server-side demotion takes effect (e.g. admin changed our
  // role from mentor to student) while we're sitting on the Parts
  // section, snap back to Files so the user isn't staring at a
  // hidden panel (Parts is mentor-gated).
  useEffect(() => {
    if (!isMentor && activeSection === 'parts') setActiveSection('files')
  }, [isMentor, activeSection])

  const openAdminOverlay = useCallback(() => {
    if (!showAdmin) setShowAdmin(true)
  }, [showAdmin])

  const handleSidebarSelect = useCallback((section: SidebarSection) => {
    if (section === 'admin') {
      openAdminOverlay()
    } else {
      setActiveSection(section)
    }
  }, [openAdminOverlay])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        ;(async () => {
          try {
            const r = await window.api.checkForUpdate()
            if (!r.success) {
              alert(`Could not check for updates: ${r.error || 'unknown error'}`)
            } else if (r.noReleasesYet) {
              alert(`You're on v${r.currentVersion}. No published releases to compare against yet.`)
            } else if (r.artifactPending) {
              alert(`Update found but the installer is still being built. Will keep checking in the background — you'll see a banner when it's ready.`)
            } else if (r.updateAvailable) {
              alert(`Update available — v${r.latestVersion} is downloading in the background.`)
            } else {
              alert(`You're on the latest version (v${r.currentVersion}).`)
            }
          } catch (err) {
            alert(`Could not check for updates: ${(err as Error).message}`)
          }
        })()
        return
      }
      // Ctrl+Shift+A: toggle the Settings overlay (works in welcome and project views)
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (showAdmin) {
          setShowAdmin(false)
          return
        }
        openAdminOverlay()
      }
      // Ctrl+Shift+D: toggle the OpenDyslexic UI font
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setDyslexicFont(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showAdmin, openAdminOverlay, project])

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem('framecad-theme')
    return stored === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('framecad-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  // OpenDyslexic UI font, toggleable for users who find the default
  // harder to read. Persisted in localStorage so it stays on across
  // launches.
  const [dyslexicFont, setDyslexicFont] = useState<boolean>(() =>
    localStorage.getItem('framecad-dyslexic-font') === '1'
  )
  useEffect(() => {
    if (dyslexicFont) document.documentElement.setAttribute('data-font', 'dyslexic')
    else document.documentElement.removeAttribute('data-font')
    localStorage.setItem('framecad-dyslexic-font', dyslexicFont ? '1' : '0')
  }, [dyslexicFont])

  useEffect(() => {
    // Identity is the team-server display name now (set at enrollment).
    // getGitIdentity() returns that name; email is always '' on the
    // Drive-only backend. Read here purely for the header user badge.
    window.api.getGitIdentity().then(({ name }) => {
      setGitName(name)
      setIdentityChecked(true)
    }).catch(() => setIdentityChecked(true))
  }, [])

  // Re-sync the display name when the team snapshot lands. On a FIRST
  // enrollment `me` is null at mount (so getGitIdentity returned ''), and the
  // snapshot arrives a moment later via push — without this the header badge +
  // read-only Profile stayed blank until the next app restart.
  useEffect(() => {
    const name = teamSnapshot?.me?.displayName
    if (name) setGitName(name)
  }, [teamSnapshot?.me?.displayName])

  useEffect(() => {
    const cleanups = [
      window.api.onUpdateAvailable((info) => {
        setUpdateInfo(info)
        setUpdateRetry(null)
        setUpdateError(null)
      }),
      window.api.onUpdateDownloadProgress(({ percent }) => {
        setUpdateProgress(percent)
        setUpdateError(null)
      }),
      window.api.onUpdateDownloaded(() => {
        setUpdateProgress(null)
        setUpdateReady(true)
        setUpdateRetry(null)
        setUpdateError(null)
      }),
      window.api.onUpdateRetryStatus((data) => {
        setUpdateRetry(data.status === 'found' || data.status === 'none' || data.status === 'cancelled' ? null : data)
      }),
      window.api.onUpdateError(({ message }) => {
        setUpdateProgress(null)
        setUpdateError(message)
      })
    ]
    // Guard against a preload that ever returns undefined for one of
    // these subscriptions (contract violation but cheap to defend).
    return () => cleanups.forEach(fn => { if (typeof fn === 'function') fn() })
  }, [])

  // Parts data for the sidebar badge + Parts/Approvals views
  const parts = useParts({ enabled: !!project })

  // Flush any queued Parts-Manager edits (1.2s debounce in useParts) to the
  // main process BEFORE syncing or publishing. Without this, a metadata edit
  // made within the debounce window of clicking Sync/Publish never reaches
  // parts-meta.json in time and silently ships in a *later* publish.
  const syncWithFlush = useCallback(async () => {
    await parts.flushNow()
    return sync()
  }, [parts.flushNow, sync])

  const publishWithFlush = useCallback(async (message: string) => {
    await parts.flushNow()
    return publish(message)
  }, [parts.flushNow, publish])

  const stats = useMemo(() => ({
    modified: countByState(files, 'modified'),
    untracked: countByState(files, 'untracked'),
    lockedByYou: countByState(files, 'locked-by-you'),
    lockedByOther: countByState(files, 'locked-by-other')
  }), [files])

  // Path → FileEntry index for cross-component navigation (e.g. the
  // DetailsPanel "Where Used" links). Rebuilt only when the file tree
  // changes since it's a O(n) walk.
  const filesByPath = useMemo(() => {
    const map = new Map<string, FileEntry>()
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        map.set(e.path, e)
        if (e.children) walk(e.children)
      }
    }
    walk(files)
    return map
  }, [files])

  const navigateToPath = useCallback((p: string) => {
    const entry = filesByPath.get(p)
    if (!entry) {
      setError(`“${p}” is no longer in the project — it may have been renamed or deleted. Sync to refresh.`)
      return
    }
    setActiveSection('files')
    setSelectedFile(entry)
  }, [filesByPath, setSelectedFile, setError])

  const sidebarBadges = useMemo(() => {
    const filesBadge = stats.modified + stats.untracked
    return {
      files: filesBadge > 0 ? filesBadge : undefined,
      parts: parts.inReviewParts.length > 0 ? parts.inReviewParts.length : undefined
    }
  }, [stats, parts.inReviewParts.length])

  const copyError = () => {
    // Chrome rejects clipboard.writeText with "Document is not
    // focused" when the window momentarily loses focus between the
    // click event and the API call (happens with our error banner
    // because the dismiss-button hover can briefly steal focus).
    // Swallow the rejection so it doesn't bubble up to the global
    // unhandledrejection handler in main.tsx.
    if (error) {
      navigator.clipboard.writeText(error).catch(() => { /* clipboard blocked */ })
    }
  }

  const displayError = error
  const errorBanner = error && (
    <div className="error-banner">
      <span className="error-banner-message" title={displayError ?? ''}>{displayError}</span>
      <div className="error-banner-actions">
        {reportState === 'idle' && (
          <button
            onClick={() => setReportState('confirm')}
            title="Send this error to your team's admin"
          >
            Report
          </button>
        )}
        {reportState === 'confirm' && (
          <>
            <span className="error-banner-prompt">Send to your team admin?</span>
            <button onClick={submitReport} className="primary">Yes</button>
            <button onClick={() => setReportState('idle')}>No</button>
          </>
        )}
        {reportState === 'sending' && (
          <span className="error-banner-prompt">Reporting…</span>
        )}
        {reportState === 'sent' && (
          <span className="error-banner-prompt">
            {reportResult.id ? `Reported #${reportResult.id}` : 'Reported'}
          </span>
        )}
        {reportState === 'failed' && (
          <span
            className="error-banner-prompt"
            title={reportResult.error}
          >
            Report failed
          </span>
        )}
        <button onClick={copyError} title="Copy error">Copy</button>
        <button onClick={dismissError} className="error-banner-close" title="Dismiss">
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )

  const retryBanner = updateRetry && (
    <div className="update-banner">
      {updateRetry.status === 'waiting' ? (
        <>
          <span>Update found — installer still building. Retrying ({updateRetry.attempt}/{updateRetry.maxAttempts})...</span>
          <button onClick={() => window.api.cancelUpdateRetry()}>Dismiss</button>
        </>
      ) : updateRetry.status === 'checking' ? (
        <span>Checking for installer... (attempt {updateRetry.attempt}/{updateRetry.maxAttempts})</span>
      ) : updateRetry.status === 'gave-up' ? (
        <>
          <span>Installer not ready yet. Try again later with Ctrl+Shift+R.</span>
          <button onClick={() => setUpdateRetry(null)}>Dismiss</button>
        </>
      ) : null}
    </div>
  )

  const updateBanner = updateInfo ? (
    <div className="update-banner">
      {updateError ? (
        <>
          <span>Update v{updateInfo.version} couldn’t download automatically. {updateError}</span>
          <button onClick={() => window.api.openExternal('https://github.com/netarcx/FrameCAD/releases/latest')}>Download manually</button>
          <button onClick={() => { setUpdateInfo(null); setUpdateError(null) }}>Dismiss</button>
        </>
      ) : updateReady ? (
        <>
          <span>Update v{updateInfo.version} ready to install</span>
          <button onClick={() => window.api.restartToUpdate()}>Restart Now</button>
        </>
      ) : updateProgress != null ? (
        <>
          <span>Downloading v{updateInfo.version}... {updateProgress}%</span>
          <div className="update-progress">
            <div className="update-progress-bar" style={{ width: `${updateProgress}%` }} />
          </div>
        </>
      ) : (
        <span>Update v{updateInfo.version} available — downloading...</span>
      )}
    </div>
  ) : retryBanner

  if (!identityChecked) return null

  const versionCorner = appVersion && <div className="app-version-corner">v{appVersion}</div>

  const offlineBanner = offline && (
    <div className="offline-banner">
      You're offline — Download / Upload will fail until your connection is back. Local edits are safe.
    </div>
  )

  // When the team server has CONFIRMED that this project's GitHub
  // repo no longer exists (admin clicked "Check now" and got 404),
  // show a persistent banner so the user knows their local clone
  // is orphaned. Authoritative server signal — never derived from
  // the client's own git errors, since those usually mean offline.
  const openProjectEntry = project && teamSnapshot?.projects
    ? teamSnapshot.projects.find(p => p.repoUrl
        .replace(/\.git$/i, '').toLowerCase() === project.remote?.replace(/\.git$/i, '').toLowerCase())
    : null
  const repoDeletedBanner = openProjectEntry?.remoteStatus === 'missing' && (
    <div className="error-banner" style={{ background: 'rgba(251, 113, 133, 0.18)' }}>
      <span className="error-banner-message">
        ⚠ Your admin has confirmed this project's remote storage no longer
        exists. Your local files are still here — back up anything you need,
        then close this project and delete the local folder.
      </span>
    </div>
  )

  // Kiosk + auto-open dead-end recovery. When a kiosk-locked device's
  // assigned project is unreachable (deleted on GitHub OR never
  // cloned and the user can't navigate to clone it), the welcome
  // screen renders without ANY actionable path forward. Surface a
  // banner that explicitly names the trap + tells the user about the
  // release hotkey so a coach can rescue them in person.
  const kioskAutoOpenEntry = kioskMode && teamSnapshot?.me?.autoOpenProjectId
    ? teamSnapshot?.projects?.find(p => p.id === teamSnapshot.me!.autoOpenProjectId)
    : null
  const kioskStuck = kioskMode
    && !project
    && !!kioskAutoOpenEntry
    // Two ways to land in the stuck state:
    //   - Project is deleted on the server (remoteStatus 'missing').
    //   - Project isn't deleted but our auto-open effect already
    //     attempted and gave up (no local clone, can't navigate to
    //     other projects in kiosk mode).
    && (kioskAutoOpenEntry.remoteStatus === 'missing'
        || autoOpenAttempted === teamSnapshot.me!.autoOpenProjectId)
  const kioskStuckBanner = kioskStuck && (
    <div className="error-banner" style={{ background: 'rgba(252, 211, 77, 0.18)' }}>
      <span className="error-banner-message">
        ⚠ This device is locked to a team project that isn't available:
        {' '}<strong>{kioskAutoOpenEntry?.name}</strong>{' '}
        {kioskAutoOpenEntry?.remoteStatus === 'missing'
          ? '— its storage has been deleted.'
          : '— it hasn\'t been downloaded locally yet.'}
        {' '}Press <span className="mono">Ctrl+Shift+Alt+R</span> to release this
        device from team management, or contact your admin.
      </span>
    </div>
  )

  const onboardingModal = showOnboarding && (
    <OnboardingTour onClose={dismissOnboarding} />
  )

  const progressModal = publishProgress && !progressHidden && (
    <div className="modal-overlay">
      <div className="modal publish-progress-modal">
        <h2>
          {publishProgress.phase === 'preparing' && (progressKind === 'join' ? 'Preparing download…' : 'Preparing upload...')}
          {publishProgress.phase === 'uploading' && (progressKind === 'join' ? 'Downloading from the Shared Drive' : 'Uploading to the Shared Drive')}
          {publishProgress.phase === 'done' && (progressKind === 'join' ? 'Download complete' : 'Upload complete')}
          {publishProgress.phase === 'error' && (progressKind === 'join' ? 'Download failed' : 'Upload failed')}
        </h2>
        {publishProgress.detail && <p className="publish-detail">{publishProgress.detail}</p>}
        {typeof publishProgress.percent === 'number' && (
          <div className="publish-progress-bar">
            <div className="publish-progress-fill" style={{ width: `${publishProgress.percent}%` }} />
            <span className="publish-progress-pct">{publishProgress.percent}%</span>
          </div>
        )}
        {publishProgress.files && publishProgress.files.length > 0 && (
          <div className="publish-file-list">
            <div className="publish-file-list-header">
              {publishProgress.files.length} file{publishProgress.files.length === 1 ? '' : 's'} in this upload
            </div>
            <ul>
              {publishProgress.files.slice(0, 30).map(f => (
                <li key={f}>{f}</li>
              ))}
              {publishProgress.files.length > 30 && (
                <li className="publish-file-more">+ {publishProgress.files.length - 30} more</li>
              )}
            </ul>
          </div>
        )}
        {publishProgress.phase === 'error' && (() => {
          // When the publish failed AND the server has already
          // confirmed this project's repo is gone, upgrade the
          // generic offline-vs-deleted message to the authoritative
          // "deleted, back up your files" copy. The publish-side
          // detectRemoteGoneError() can't tell the difference;
          // the team server's snapshot can.
          const isConfirmedDeleted = !!publishProgress.remoteGone
            && openProjectEntry?.remoteStatus === 'missing'
          const message = isConfirmedDeleted
            ? "Your admin has confirmed this project's remote storage no "
              + 'longer exists. Your local files are still here — back '
              + 'up anything you need, then close this project and '
              + 'delete the local folder.'
            : publishProgress.error || 'Unknown error'
          return <ErrorMsg text={message} />
        })()}
        <div className="actions">
          {publishProgress.phase === 'error' || publishProgress.phase === 'done' ? (
            <button
              className="toolbar-btn primary"
              onClick={() => { setPublishProgress(null); setProgressHidden(false) }}
            >
              Close
            </button>
          ) : (
            <button
              className="toolbar-btn"
              onClick={() => setProgressHidden(true)}
              title="Move this dialog to a strip at the bottom of the window. Upload keeps running."
            >
              Hide
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // ── Archive mode (read-only local mirror) ──
  // Takes precedence over the welcome screen, auto-open, and kiosk: an
  // archive device has no editing surface, only a status dashboard.
  if (archiveMode) {
    return (
      <ArchiveDashboard
        teamSnapshot={teamSnapshot}
        serverReach={serverReach}
        gitName={gitName}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }

  // ── Welcome screen (no project open) ──
  if (!project) {
    return (
      <div className="app">
        <datalist id={DEFAULT_MATERIALS_DATALIST_ID}>
          {DEFAULT_MATERIALS.map(m => <option key={m} value={m} />)}
        </datalist>
        {updateBanner}
        {errorBanner}
        {/* Kiosk-stuck banner lives in the welcome-screen branch too:
            kiosk-mode users with an unreachable assigned project never
            leave this branch, so the banner was previously rendered
            below (in the project-view branch) where they could never
            see it. */}
        {kioskStuckBanner}
        <ProjectSetup
          onJoinDriveProject={joinDriveProject}
          onOpenProject={openProject}
          teamSnapshot={teamSnapshot}
          onTeamRefresh={team.refresh}
          onEnterManufacturingView={async () => {
            const recents = await window.api.getRecentProjects()
            // Open the most-recent DRIVE project (a stale pre-migration git
            // recent at index 0 would just throw "isn't a FrameCAD project").
            const target = recents.find(r => r.backend === 'drive') ?? recents[0]
            if (!target) return
            // Flip into manufacturing mode BEFORE awaiting openProject —
            // otherwise the regular project view (with the sidebar) renders
            // for the duration of the open, which the user sees as a sidebar
            // that mysteriously hides when the kiosk shell takes over. The
            // `manufacturingView && project` gate keeps the welcome screen up
            // until project actually arrives.
            setManufacturingView(true)
            const ok = await openProject(target.path)
            // Open failed (error already surfaced) — roll back so we don't
            // strand in the kiosk shell with no project.
            if (!ok) setManufacturingView(false)
          }}
          onOpenAdmin={openAdminOverlay}
          isLoading={isLoading}
          globalAdmin={globalAdmin}
        />
        {showAdmin && (
          <AdminPage
            hasProject={false}
            isAdmin={isAdmin}
            isMentor={isMentor}
            canForceCheckIn={canForceCheckIn}
            appVersion={appVersion}
            gitName={gitName}
            onClose={() => {
              setShowAdmin(false)
              refreshGlobalAdmin()
              team.refresh().catch(() => { /* offline */ })
            }}
          />
        )}
        {offlineBanner}
        {onboardingModal}
        {progressModal}
        {versionCorner}
      </div>
    )
  }

  // ── Shop-floor kiosk mode ──
  if (manufacturingView && project) {
    return (
      <ManufacturingModeShell
        project={project}
        onSwitchProject={async (targetPath) => {
          try {
            await closeProject()
            await openProject(targetPath)
          } catch {
            setManufacturingView(false)
          }
        }}
        onExit={() => { setManufacturingView(false); closeProject() }}
      />
    )
  }

  // ── Main project view (sidebar layout) ──
  // On wide screens DetailsPanel is always rendered inline when the
  // active section supports it. On medium/compact tiers it becomes an
  // overlay that only appears when a file is actually selected so the
  // content underneath stays usable.
  const inspectorSection = activeSection === 'files' || activeSection === 'parts'
  const isOverlayTier = layoutTier !== 'wide'
  const showInspector = inspectorSection && inspectorOpen &&
    (!isOverlayTier || !!selectedFile)

  const materialDatalist = (
    <datalist id={DEFAULT_MATERIALS_DATALIST_ID}>
      {DEFAULT_MATERIALS.map(m => <option key={m} value={m} />)}
    </datalist>
  )

  return (
    <div className="app">
      {materialDatalist}
      {updateBanner}
      {errorBanner}

      <div className="app-header">
        {/* In kiosk mode the welcome screen is unreachable by design,
            so closing/going back is a dead end (the auto-open effect
            would re-fire). Render the brand as a non-interactive
            label instead of a button, and drop the back arrow
            entirely. Non-kiosk users get the usual two-click exit. */}
        {kioskMode ? (
          <div className="logo-home-btn" style={{ cursor: 'default' }}>
            <img className="logo-img" src={logoUrl} alt="FrameCAD" />
            <span className="logo">FrameCAD</span>
          </div>
        ) : (
          <>
            <button
              className="logo-home-btn"
              onClick={() => { setActiveSection('files'); closeProject() }}
              title="Close this project and return to the welcome screen"
            >
              <img className="logo-img" src={logoUrl} alt="FrameCAD" />
              <span className="logo">FrameCAD</span>
            </button>
            <span className="divider" />
            <button
              className="back-btn"
              onClick={() => { setActiveSection('files'); closeProject() }}
              title="Close this project and go back to the project picker"
            >
              <ChevronLeft size={16} strokeWidth={2} />
              <span>Back</span>
            </button>
          </>
        )}
        <span className="project-name-label" title={project.path}>{project.name}</span>
        <span className="spacer" />
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark'
            ? <Sun size={16} strokeWidth={1.75} />
            : <Moon size={16} strokeWidth={1.75} />}
        </button>
        <span
          className="user-badge"
          title={`Signed in as ${gitName}`}
        >
          {gitName}
        </span>
      </div>

      <Toolbar
        onSync={syncWithFlush}
        onPublish={publishWithFlush}
        onNewPart={createNewPart}
        onNewAssembly={createNewAssembly}
        onNewSubsystem={createSubsystem}
        selectedFile={selectedFile}
        isLoading={isLoading}
        hasProject={true}
        isCotsProject={adminConfig.isCotsProject}
        activeSection={activeSection}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen(o => !o)}
        legacyMode={parts.legacyMode}
        canManageCad={canManageCad}
      />

      <div className="app-main">
        <Sidebar
          active={activeSection}
          onSelect={handleSidebarSelect}
          badges={sidebarBadges}
          isMentor={isMentor}
        />

        <div className="app-content">
          {activeSection === 'files' && (
            <>
              {parts.error && <ErrorMsg text={parts.error} style={{ margin: '8px 16px' }} />}
              <ProjectBrowser
                files={files}
                selectedFile={selectedFile}
                onSelect={setSelectedFile}
                onCheckOut={checkOut}
                onCheckIn={checkIn}
                onBulkApply={isMentor ? parts.bulkApply : undefined}
              />
            </>
          )}

          {activeSection === 'parts' && isMentor && (
            <div className="parts-content">
              {parts.error && <ErrorMsg text={parts.error} style={{ margin: '8px 16px' }} />}
              <div className="parts-content-tabs">
                <button
                  className={`parts-tab${parts.stateFilter !== 'in-review' ? ' active' : ''}`}
                  onClick={() => parts.setStateFilter('all')}
                >
                  All Parts
                </button>
                <button
                  className={`parts-tab${parts.stateFilter === 'in-review' ? ' active' : ''}`}
                  onClick={() => parts.setStateFilter('in-review')}
                >
                  Needs Review {parts.inReviewParts.length > 0 && <span className="parts-tab-badge">{parts.inReviewParts.length}</span>}
                </button>
              </div>
              <div className="parts-panel">
                {parts.stateFilter === 'in-review' ? (
                  <ApprovalsPanel
                    parts={parts.inReviewParts}
                    onApprove={(p) => parts.setReleaseState(p, 'released')}
                    onReject={(p) => parts.setReleaseState(p, 'draft')}
                    onRefresh={parts.loadAllParts}
                  />
                ) : (
                  <PartsManager
                    loading={parts.loading}
                    parts={parts.filteredParts}
                    allParts={parts.allParts}
                    filter={parts.filter}
                    setFilter={parts.setFilter}
                    subsystem={parts.subsystem}
                    setSubsystem={parts.setSubsystem}
                    subsystemOptions={parts.subsystemOptions}
                    state={parts.stateFilter}
                    setState={parts.setStateFilter}
                    pendingCount={parts.pendingCount}
                    flushing={parts.flushing}
                    flushNow={parts.flushNow}
                    onRefresh={parts.loadAllParts}
                    onSetRelease={parts.setReleaseState}
                    onSetMethod={parts.setMethod}
                    onSetMaterial={parts.setMaterial}
                    onSetMass={parts.setMass}
                    onSetCost={parts.setCost}
                    onBulkApply={parts.bulkApply}
                  />
                )}
              </div>
            </div>
          )}

          {activeSection === 'activity' && (
            <ActivityView history={history} />
          )}

          {activeSection === 'shop' && (
            <ManufacturingQueue embedded onClose={() => setActiveSection('files')} />
          )}
        </div>

        {showInspector && isOverlayTier && (
          <div
            className="details-overlay-backdrop"
            onClick={() => setInspectorOpen(false)}
            aria-hidden="true"
          />
        )}
        {showInspector && (
          <DetailsPanel
            file={selectedFile}
            onCheckOut={checkOut}
            onCheckIn={checkIn}
            onClose={isOverlayTier ? () => setInspectorOpen(false) : undefined}
            onNavigate={navigateToPath}
            isMentor={isMentor}
            isLoading={isLoading}
          />
        )}
      </div>


      {showAdmin && (
        <AdminPage
          hasProject={true}
          isAdmin={isAdmin}
          isMentor={isMentor}
          canForceCheckIn={canForceCheckIn}
          appVersion={appVersion}
          gitName={gitName}
          onClose={() => {
            setShowAdmin(false)
            refreshGlobalAdmin()
            team.refresh().catch(() => { /* offline */ })
            refreshAdminConfig()
          }}
        />
      )}

      {offlineBanner}
      {repoDeletedBanner}
      {kioskStuckBanner}
      {onboardingModal}

      {progressModal}

      {publishProgress && progressHidden && (
        <button
          type="button"
          className="publish-mini-bar"
          onClick={() => setProgressHidden(false)}
          title="Click to expand the upload details"
        >
          <span className="publish-mini-bar-title">
            {publishProgress.phase === 'preparing' && (progressKind === 'join' ? 'Preparing download…' : 'Preparing upload…')}
            {publishProgress.phase === 'uploading' && (progressKind === 'join' ? 'Downloading from the Shared Drive' : 'Uploading to the Shared Drive')}
            {publishProgress.phase === 'done' && (progressKind === 'join' ? 'Download complete' : 'Upload complete')}
            {publishProgress.phase === 'error' && (progressKind === 'join' ? 'Download failed' : 'Upload failed')}
          </span>
          {publishProgress.detail && (
            <span className="publish-mini-bar-detail">{publishProgress.detail}</span>
          )}
          {typeof publishProgress.percent === 'number' && (
            <span className="publish-mini-bar-track">
              <span
                className="publish-mini-bar-fill"
                style={{ width: `${publishProgress.percent}%` }}
              />
            </span>
          )}
          {typeof publishProgress.percent === 'number' && (
            <span className="publish-mini-bar-pct">{publishProgress.percent}%</span>
          )}
          <span className="publish-mini-bar-expand">Show</span>
        </button>
      )}

      <div className="status-bar">
        <BusyLabel />
        {projectTotals && projectTotals.totalParts > 0 && (!adminConfig.hideMass || !adminConfig.hideCost) && (
          <>
            {!adminConfig.hideMass && (
              <span className="status-item robot-totals" title={`From ${projectTotals.partsWithMass} of ${projectTotals.totalParts} parts`}>
                <strong>Robot:</strong> {projectTotals.mass.toFixed(1)} lb
              </span>
            )}
            {!adminConfig.hideCost && (
              <span className="status-item robot-totals" title={`From ${projectTotals.partsWithCost} of ${projectTotals.totalParts} parts`}>
                <strong>$</strong>{projectTotals.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            )}
            <span className="status-sep" />
          </>
        )}
        {stats.modified > 0 && (
          <span className="status-item">
            <span className="status-dot modified" />
            {stats.modified} modified
          </span>
        )}
        {stats.untracked > 0 && (
          <span className="status-item">
            <span className="status-dot untracked" />
            {stats.untracked} new
          </span>
        )}
        {stats.lockedByYou > 0 && (
          <span className="status-item">
            <span className="status-dot locked-by-you" />
            {stats.lockedByYou} checked out by you
          </span>
        )}
        {stats.lockedByOther > 0 && (
          <span className="status-item">
            <span className="status-dot locked-by-other" />
            {stats.lockedByOther} locked by others
          </span>
        )}
        {locks.length > 0 && (
          <span className="status-item">
            {locks.length} total lock{locks.length !== 1 ? 's' : ''}
          </span>
        )}
        {/* Team server reachability dot. Hidden in standalone mode
            (no server URL configured); otherwise shows green when
            /api/health responded 200 within 4s, red when we couldn't
            reach it, and stays neutral during the first-load
            'unknown' window. */}
        {serverReach !== 'not-enrolled' && serverReach !== 'unknown' && (
          <span
            className="status-item"
            title={serverReach === 'reachable'
              ? 'Team server reachable'
              : "Can't reach the team server — Sync / Publish will fail until connectivity comes back"}
            style={{ marginLeft: 'auto' }}
          >
            <span
              className="status-dot"
              style={{
                background: serverReach === 'reachable' ? 'var(--green)' : 'var(--red)',
              }}
            />
            {serverReach === 'reachable' ? 'Server online' : 'Server offline'}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Status-bar pill that names what FrameCAD is currently doing in the
 * background (e.g. "Cloning project", "Syncing"). Lit only when the
 * activity has run past the 300 ms grace period in apiBusy, so quick
 * reads don't flicker the label on every click.
 */
function BusyLabel(): JSX.Element | null {
  const { busy, label } = useApiBusy()
  if (!busy) return null
  return (
    <span className="status-item busy-label" aria-live="polite">
      <span className="busy-label-spinner" />
      {label}…
    </span>
  )
}
