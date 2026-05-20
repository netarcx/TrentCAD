import { FolderOpen, Wrench, Activity, Factory, Settings, type LucideIcon } from 'lucide-react'

export type SidebarSection = 'files' | 'parts' | 'activity' | 'shop' | 'admin'

interface Props {
  active: SidebarSection
  onSelect: (section: SidebarSection) => void
  badges?: { files?: number; parts?: number }
  /** Parts Manager (bulk edit, approvals queue) is mentor+ only. Hide
   *  the entry for students so they can't reach the bulk dropdown that
   *  bypasses the DetailsPanel release-state gate. */
  isMentor: boolean
}

const allItems: { id: SidebarSection; label: string; Icon: LucideIcon; mentorOnly?: boolean }[] = [
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'parts', label: 'Parts', Icon: Wrench, mentorOnly: true },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'shop', label: 'Shop', Icon: Factory }
]

export default function Sidebar({ active, onSelect, badges, isMentor }: Props) {
  const items = allItems.filter(i => isMentor || !i.mentorOnly)
  return (
    <nav className="app-sidebar">
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`sidebar-item${active === id ? ' active' : ''}`}
          onClick={() => onSelect(id)}
        >
          <span className="sidebar-icon"><Icon size={20} strokeWidth={1.75} /></span>
          <span className="sidebar-label">{label}</span>
          {badges && badges[id as keyof typeof badges] ? (
            <span className="sidebar-badge">{badges[id as keyof typeof badges]}</span>
          ) : null}
        </button>
      ))}
      <div className="sidebar-spacer" />
      <button
        className={`sidebar-item${active === 'admin' ? ' active' : ''}`}
        onClick={() => onSelect('admin')}
      >
        <span className="sidebar-icon"><Settings size={20} strokeWidth={1.75} /></span>
        <span className="sidebar-label">Settings</span>
      </button>
    </nav>
  )
}
