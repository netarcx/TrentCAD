import { useMemo } from 'react'
import { Upload, Sparkles, Tag, Settings, type LucideIcon } from 'lucide-react'
import type { HistoryEntry } from '@shared/types'

interface Props {
  history: HistoryEntry[]
}

type EventKind = 'init' | 'admin' | 'reserve' | 'publish'

interface ClassifiedEvent {
  entry: HistoryEntry
  kind: EventKind
  label: string
  Icon: LucideIcon
  cleanMessage: string
}

function classify(entry: HistoryEntry): ClassifiedEvent {
  const msg = entry.message.trim()
  if (msg === 'Initialize FrameCAD project') {
    return { entry, kind: 'init', label: 'Project created', Icon: Sparkles, cleanMessage: '' }
  }
  if (msg.startsWith('[admin]')) {
    return {
      entry, kind: 'admin', label: 'Settings updated',
      Icon: Settings, cleanMessage: msg.replace(/^\[admin\]\s*/, '')
    }
  }
  if (msg.startsWith('Reserve ')) {
    return {
      entry, kind: 'reserve', label: 'Part number reserved',
      Icon: Tag, cleanMessage: msg.replace(/^Reserve\s+/, '')
    }
  }
  return { entry, kind: 'publish', label: 'Files published', Icon: Upload, cleanMessage: msg }
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dayLabel(timestamp: number): string {
  const today = startOfDay(new Date())
  const day = startOfDay(new Date(timestamp))
  const diffDays = Math.round((today - day) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'long' })
  if (diffDays < 365) return new Date(timestamp).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function timeLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function initialsOf(author: string): string {
  const trimmed = author.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

interface DayGroup {
  label: string
  dayStart: number
  events: ClassifiedEvent[]
}

function groupByDay(events: ClassifiedEvent[]): DayGroup[] {
  const map = new Map<number, DayGroup>()
  for (const ev of events) {
    const dayStart = startOfDay(new Date(ev.entry.date))
    let group = map.get(dayStart)
    if (!group) {
      group = { label: dayLabel(dayStart), dayStart, events: [] }
      map.set(dayStart, group)
    }
    group.events.push(ev)
  }
  return Array.from(map.values()).sort((a, b) => b.dayStart - a.dayStart)
}

export default function ActivityView({ history }: Props) {
  const groups = useMemo(() => {
    const classified = history.map(classify)
    return groupByDay(classified)
  }, [history])

  const totalLabel = `${history.length} event${history.length === 1 ? '' : 's'}`

  if (history.length === 0) {
    return (
      <div className="activity-view">
        <div className="activity-view-header">
          <h3>Activity</h3>
        </div>
        <div className="activity-view-empty">
          Nothing has happened yet. Publish your first changes and they'll show up here.
        </div>
      </div>
    )
  }

  return (
    <div className="activity-view">
      <div className="activity-view-header">
        <h3>Activity</h3>
        <span className="activity-view-count">{totalLabel}</span>
      </div>
      <div className="activity-feed">
        {groups.map(group => (
          <div className="activity-day-group" key={group.dayStart}>
            <div className="activity-day-header">{group.label}</div>
            <div className="activity-day-events">
              {group.events.map(({ entry, label, Icon, cleanMessage, kind }) => (
                <div key={entry.hash} className={`activity-event activity-event-${kind}`}>
                  <div className="activity-event-icon"><Icon size={16} strokeWidth={1.75} /></div>
                  <div className="activity-event-body">
                    <div className="activity-event-line">
                      <span className="activity-event-author" title={entry.author}>{entry.author}</span>
                      <span className="activity-event-action">{label.toLowerCase()}</span>
                      {cleanMessage && (
                        <span className="activity-event-msg">— {cleanMessage}</span>
                      )}
                    </div>
                    {entry.files.length > 0 && kind === 'publish' && (
                      <div className="activity-event-files">
                        {entry.files.length === 1
                          ? entry.files[0]
                          : `${entry.files.length} files (${entry.files.slice(0, 3).join(', ')}${entry.files.length > 3 ? '…' : ''})`}
                      </div>
                    )}
                  </div>
                  <div className="activity-event-side">
                    <div className="activity-event-avatar" title={entry.author}>{initialsOf(entry.author)}</div>
                    <div className="activity-event-time">{timeLabel(entry.date)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
