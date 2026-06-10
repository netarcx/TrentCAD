import { useState, useEffect, useRef } from 'react'
import { Download, Upload, Plus, ChevronDown, PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import type { SidebarSection } from './Sidebar'

interface Props {
  onSync: () => void
  onPublish: (message: string) => void
  onNewPart: (folder: string, description?: string) => Promise<{ partNumber: string; filePath: string } | null>
  onNewAssembly: (parentFolder: string, name: string, description?: string) => Promise<{ partNumber: string; filePath: string } | null>
  onNewSubsystem: (parentFolder: string, name: string) => Promise<{ folderPath: string } | null>
  selectedFile: FileEntry | null
  isLoading: boolean
  hasProject: boolean
  isCotsProject?: boolean
  activeSection: SidebarSection
  inspectorOpen: boolean
  onToggleInspector: () => void
  /** When true, this project pre-dates FrameCAD's part-numbering and
   *  uses filenames as the de-facto part numbers. The auto-numbered
   *  New Part / New Assembly buttons are hidden so we don't impose
   *  the YY-team-XX-YYY scheme on a project that has its own. */
  legacyMode?: boolean
  /** Whether this user may manage the CAD file structure (create parts /
   *  assemblies / subsystem folders). Mentors/admins always can; a student
   *  needs the server-granted `manageCadStructure` capability. Gates the
   *  "New" menu. Defaults true so non-team / standalone use is unaffected. */
  canManageCad?: boolean
}

function getSelectedFolder(file: FileEntry | null): string {
  if (!file) return ''
  if (file.isDirectory) return file.path
  return file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
}

export default function Toolbar({
  onSync, onPublish, onNewPart, onNewAssembly, onNewSubsystem,
  selectedFile, isLoading, hasProject, isCotsProject,
  activeSection, inspectorOpen, onToggleInspector,
  legacyMode = false, canManageCad = true
}: Props) {
  const [showPublish, setShowPublish] = useState(false)
  const [message, setMessage] = useState('')
  const [showNewPart, setShowNewPart] = useState(false)
  const [showNewAssembly, setShowNewAssembly] = useState(false)
  const [partDescription, setPartDescription] = useState('')
  const [assemblyName, setAssemblyName] = useState('')
  const [assemblyDescription, setAssemblyDescription] = useState('')
  const [showNewSubsystem, setShowNewSubsystem] = useState(false)
  const [subsystemName, setSubsystemName] = useState('')
  const [createdInfo, setCreatedInfo] = useState<{ partNumber: string; filePath: string } | null>(null)
  const [createdFolder, setCreatedFolder] = useState<string | null>(null)
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const createMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showCreateMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setShowCreateMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showCreateMenu])

  // Each handler guards on isLoading itself — the buttons are disabled,
  // but the Enter-key paths in the modal inputs would otherwise fire the
  // action regardless.
  const handlePublish = () => {
    if (isLoading) return
    onPublish(message.trim())
    setMessage('')
    setShowPublish(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handlePublish()
    if (e.key === 'Escape') setShowPublish(false)
  }

  const handleNewPart = async () => {
    if (isLoading) return
    const folder = getSelectedFolder(selectedFile)
    const result = await onNewPart(folder, partDescription.trim() || undefined)
    if (result) {
      setCreatedInfo(result)
      setPartDescription('')
      setShowNewPart(false)
    }
  }

  const handleNewSubsystem = async () => {
    if (isLoading) return
    if (!subsystemName.trim()) return
    const parentFolder = getSelectedFolder(selectedFile)
    const result = await onNewSubsystem(parentFolder, subsystemName.trim())
    if (result) {
      setCreatedFolder(result.folderPath)
      setSubsystemName('')
      setShowNewSubsystem(false)
    }
  }

  const handleNewAssembly = async () => {
    if (isLoading) return
    if (!assemblyName.trim()) return
    const parentFolder = getSelectedFolder(selectedFile)
    const result = await onNewAssembly(parentFolder, assemblyName.trim(), assemblyDescription.trim() || undefined)
    if (result) {
      setCreatedInfo(result)
      setAssemblyName('')
      setAssemblyDescription('')
      setShowNewAssembly(false)
    }
  }

  const currentFolder = getSelectedFolder(selectedFile)
  const showInspectorToggle = activeSection === 'files' || activeSection === 'parts'

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-group">
          <button
            className="toolbar-btn"
            onClick={onSync}
            disabled={!hasProject || isLoading}
            title="Get the latest files from your team"
          >
            {isLoading ? <span className="loading-spinner" /> : <Download size={14} strokeWidth={1.75} />} Sync
          </button>
          <button
            className="toolbar-btn primary"
            onClick={() => setShowPublish(true)}
            disabled={!hasProject || isLoading}
            title="Send your changes to the team"
          >
            <Upload size={14} strokeWidth={1.75} /> Publish
          </button>
        </div>

        {activeSection === 'files' && !isCotsProject && canManageCad && (
          <>
            <div className="toolbar-sep" />
            <div className="toolbar-group">
              <div className="create-dropdown-wrap" ref={createMenuRef}>
                <button
                  className="toolbar-btn"
                  onClick={() => setShowCreateMenu(!showCreateMenu)}
                  disabled={!hasProject || isLoading}
                  title="Create a new part, assembly, or folder"
                >
                  <Plus size={14} strokeWidth={1.75} /> New <ChevronDown size={12} strokeWidth={1.75} />
                </button>
                {showCreateMenu && (
                  <div className="create-dropdown-menu" onMouseLeave={() => setShowCreateMenu(false)}>
                    {/* Hide auto-numbered creators in legacy mode — the
                        project pre-dates FrameCAD's numbering scheme and
                        the team names files themselves in SolidWorks. */}
                    {!legacyMode && (
                      <>
                        <button onClick={() => { setShowCreateMenu(false); setShowNewPart(true) }}>
                          New Part
                        </button>
                        <button onClick={() => { setShowCreateMenu(false); setShowNewAssembly(true) }}>
                          New Assembly
                        </button>
                        <div className="create-dropdown-sep" />
                      </>
                    )}
                    <button onClick={() => { setShowCreateMenu(false); setShowNewSubsystem(true) }}>
                      New Folder
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeSection === 'files' && isCotsProject && (
          <>
            <div className="toolbar-sep" />
            <div className="toolbar-group">
              <button
                className="toolbar-btn"
                onClick={() => setShowNewSubsystem(true)}
                disabled={!hasProject || isLoading}
                title="Create a new folder to organize files"
              >
                <Plus size={14} strokeWidth={1.75} /> Folder
              </button>
            </div>
          </>
        )}

        <div className="toolbar-spacer" />

        {showInspectorToggle && (
          <button
            className={`toolbar-btn toolbar-btn-icon${inspectorOpen ? ' active' : ''}`}
            onClick={onToggleInspector}
            title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          >
            {inspectorOpen
              ? <PanelRightClose size={16} strokeWidth={1.75} />
              : <PanelRightOpen size={16} strokeWidth={1.75} />}
          </button>
        )}
      </div>

      {showPublish && (
        <div className="modal-overlay" onClick={() => setShowPublish(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Upload Changes</h2>
            <input
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What did you change? (optional — leave blank for a random label)"
              autoFocus
            />
            <div className="actions">
              <button className="toolbar-btn" onClick={() => setShowPublish(false)}>Cancel</button>
              <button
                className="toolbar-btn primary"
                onClick={handlePublish}
                disabled={isLoading}
              >
                {isLoading ? <span className="loading-spinner" /> : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewPart && (
        <div className="modal-overlay" onClick={() => setShowNewPart(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New Part</h2>
            <div className="modal-info">
              Creating in: <span className="modal-path">{currentFolder || '/ (project root)'}</span>
            </div>
            <input
              value={partDescription}
              onChange={e => setPartDescription(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewPart()
                if (e.key === 'Escape') setShowNewPart(false)
              }}
              placeholder="Description (optional, e.g., Gearbox Plate)"
              autoFocus
            />
            <div className="actions">
              <button className="toolbar-btn" onClick={() => setShowNewPart(false)}>Cancel</button>
              <button
                className="toolbar-btn primary"
                onClick={handleNewPart}
                disabled={isLoading}
              >
                Create Part
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewAssembly && (
        <div className="modal-overlay" onClick={() => setShowNewAssembly(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New Assembly</h2>
            <div className="modal-info">
              Creating in: <span className="modal-path">{currentFolder || '/ (project root)'}</span>
            </div>
            <input
              value={assemblyName}
              onChange={e => setAssemblyName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewAssembly()
                if (e.key === 'Escape') setShowNewAssembly(false)
              }}
              placeholder="Assembly name (e.g., Drivetrain)"
              autoFocus
            />
            <input
              value={assemblyDescription}
              onChange={e => setAssemblyDescription(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewAssembly()
                if (e.key === 'Escape') setShowNewAssembly(false)
              }}
              placeholder="Description (optional)"
              style={{ marginTop: 8 }}
            />
            <div className="actions">
              <button className="toolbar-btn" onClick={() => setShowNewAssembly(false)}>Cancel</button>
              <button
                className="toolbar-btn primary"
                onClick={handleNewAssembly}
                disabled={!assemblyName.trim() || isLoading}
              >
                Create Assembly
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewSubsystem && (
        <div className="modal-overlay" onClick={() => setShowNewSubsystem(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New Folder</h2>
            <div className="modal-info">
              Creating in: <span className="modal-path">{currentFolder || '/ (project root)'}</span>
            </div>
            <input
              value={subsystemName}
              onChange={e => setSubsystemName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewSubsystem()
                if (e.key === 'Escape') setShowNewSubsystem(false)
              }}
              placeholder="Folder name (e.g., Drivetrain)"
              autoFocus
            />
            <div className="actions">
              <button className="toolbar-btn" onClick={() => setShowNewSubsystem(false)}>Cancel</button>
              <button
                className="toolbar-btn primary"
                onClick={handleNewSubsystem}
                disabled={!subsystemName.trim() || isLoading}
              >
                Create Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {createdFolder && (
        <div className="modal-overlay" onClick={() => setCreatedFolder(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Folder Created</h2>
            <div className="created-details">
              <div className="created-path">{createdFolder}</div>
            </div>
            <div className="actions">
              <button
                className="toolbar-btn"
                onClick={() => {
                  window.api.openFileExplorer(createdFolder)
                  setCreatedFolder(null)
                }}
              >
                Show in Explorer
              </button>
              <button className="toolbar-btn primary" onClick={() => setCreatedFolder(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {createdInfo && (
        <div className="modal-overlay" onClick={() => setCreatedInfo(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Part Number Reserved</h2>
            <div className="created-details">
              <div className="created-number">{createdInfo.partNumber}</div>
              <div className="created-path">{createdInfo.filePath}</div>
              <p className="created-hint">
                Open SolidWorks, create a new part or assembly, and save it
                with the filename above into the project folder. The file
                will then appear here with this part number attached.
              </p>
            </div>
            <div className="actions">
              <button
                className="toolbar-btn"
                onClick={() => {
                  const i = createdInfo.filePath.lastIndexOf('/')
                  const folder = i >= 0 ? createdInfo.filePath.slice(0, i) : ''
                  window.api.openFileExplorer(folder)
                  setCreatedInfo(null)
                }}
              >
                Open Folder
              </button>
              <button className="toolbar-btn primary" onClick={() => setCreatedInfo(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
