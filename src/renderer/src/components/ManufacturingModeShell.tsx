import { useEffect, useState } from 'react'
import logoUrl from '../assets/logo.png'
import ManufacturingQueue from './ManufacturingQueue'
import type { ProjectConfig } from '@shared/types'

interface Props {
  /** The currently-open project. Path is used to filter the switcher
   *  (two projects can legitimately share a name on different paths,
   *  so name alone isn't unique). */
  project: ProjectConfig
  /** Called when the user picks a different recent project from the
   *  switcher. The parent must close the current project and open the
   *  target while keeping `manufacturingView` true so the UI doesn't
   *  flash through the regular project view. */
  onSwitchProject: (targetPath: string) => Promise<void>
  /** Leave shop-floor mode and return to the welcome screen. */
  onExit: () => void
}

export default function ManufacturingModeShell({ project, onSwitchProject, onExit }: Props) {
  const [recents, setRecents] = useState<ProjectConfig[]>([])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [printResult, setPrintResult] = useState<string | null>(null)

  useEffect(() => {
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [project.path])

  // Hide the switcher when the user clicks anywhere else
  useEffect(() => {
    if (!switcherOpen) return
    const onClickAway = () => setSwitcherOpen(false)
    // Defer attaching one tick so the same click that opened it
    // doesn't immediately close it
    const id = setTimeout(() => window.addEventListener('click', onClickAway), 0)
    return () => { clearTimeout(id); window.removeEventListener('click', onClickAway) }
  }, [switcherOpen])

  // Filter by path, not name — two robots can both be called
  // "2026-Robot" if they're under different parent folders
  const otherRecents = recents.filter(r => r.path !== project.path)

  const handlePrint = async () => {
    setPrinting(true)
    setPrintResult(null)
    try {
      const r = await window.api.generateDocument('manufacturing')
      if (r.success && r.pdfFilePath) {
        await window.api.openPath(r.pdfFilePath)
        setPrintResult('✓ Opened printable cut list')
      } else if (r.success && r.filePath) {
        await window.api.openPath(r.filePath)
        setPrintResult('✓ Opened cut list (PDF unavailable; CSV opened instead)')
      } else {
        setPrintResult('✗ ' + (r.error || 'Could not generate print list'))
      }
    } catch (err) {
      setPrintResult('✗ ' + (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="app">
      <div className="app-header">
        <button
          className="logo-home-btn"
          onClick={onExit}
          title="Exit the manufacturing view"
        >
          <img className="logo-img" src={logoUrl} alt="FrameCAD" />
          <span className="logo">FrameCAD</span>
        </button>
        <span className="divider" />
        <div className="mfg-mode-project">
          {otherRecents.length > 0 ? (
            <button
              className="project-name-btn"
              onClick={(e) => { e.stopPropagation(); setSwitcherOpen(!switcherOpen) }}
              title="Switch to a different recent project"
            >
              {project.name} <span className="mfg-mode-chevron">▾</span>
            </button>
          ) : (
            <span className="project-name-btn" style={{ cursor: 'default' }}>{project.name}</span>
          )}
          {switcherOpen && otherRecents.length > 0 && (
            <div className="mfg-mode-switcher" onClick={(e) => e.stopPropagation()}>
              <div className="mfg-mode-switcher-header">Switch project</div>
              {otherRecents.slice(0, 6).map(p => (
                <button
                  key={p.path}
                  className="mfg-mode-switcher-item"
                  onClick={async () => {
                    setSwitcherOpen(false)
                    await onSwitchProject(p.path)
                  }}
                >
                  <span className="mfg-mode-switcher-name">{p.name}</span>
                  <span className="mfg-mode-switcher-path">{p.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="spacer" />
        <button
          className="toolbar-btn"
          onClick={handlePrint}
          disabled={printing}
          title="Generate and open a printable cut list PDF"
        >
          {printing ? 'Generating…' : 'Print queue'}
        </button>
        <button
          className="toolbar-btn"
          onClick={onExit}
          title="Leave the manufacturing view and return to the project picker"
        >
          Exit
        </button>
      </div>
      {printResult && (
        <div className="mfg-mode-status">{printResult}</div>
      )}
      <ManufacturingQueue />
    </div>
  )
}
