/**
 * Reusable form bundle: four capability checkboxes + project allowlist
 * multi-select + auto-open project dropdown.
 *
 * Used on the PIN-issue form (bakes caps onto the PIN) and on each
 * member row in the Members table (edits caps on an existing member).
 * Both flows talk to the server with the same `{ capabilities,
 * allowedProjectIds, autoOpenProjectId }` shape.
 */

import type { CapabilityValue, ProjectOption } from '../caps'

interface Props {
  value: CapabilityValue
  onChange: (next: CapabilityValue) => void
  projects: ProjectOption[]
  disabled?: boolean
  /** When true, hide the "Auto-open on launch" row — useful for the
   *  Members table where vertical space is tight; the dropdown still
   *  lives on the PIN-issue form. */
  hideAutoOpen?: boolean
}

/**
 * Only the capabilities the v3.x desktop client actually consults are
 * surfaced here. `createProject` / `openProject` became no-ops on the
 * client when project creation moved to the server admin UI and the
 * welcome screen collapsed into a project list. They linger in the
 * server schema for legacy data but offering them as toggles would
 * mislead admins into thinking they control something — they don't.
 *
 * The client-side gate the admin actually wants is `browseTeamProjects`
 * (controls whether the project list shows at all) and
 * `manufacturingView` (the secondary shop-floor button).
 */
const CAP_LABELS: Array<{ key: keyof CapabilityValue['capabilities']; label: string; hint: string }> = [
  { key: 'browseTeamProjects', label: 'Team Projects',      hint: 'Lets them see and join projects registered in this server.' },
  { key: 'manufacturingView',  label: 'Manufacturing View', hint: 'Shop-floor queue grouped by manufacturing method.' },
]

export default function CapabilityControls(props: Props) {
  const { value, onChange, projects, disabled, hideAutoOpen } = props
  const allowSet = new Set(value.allowedProjectIds)

  function toggleCap(key: keyof CapabilityValue['capabilities']): void {
    onChange({ ...value, capabilities: { ...value.capabilities, [key]: !value.capabilities[key] } })
  }
  function toggleAllowedProject(id: number): void {
    const next = new Set(allowSet)
    if (next.has(id)) next.delete(id); else next.add(id)
    onChange({ ...value, allowedProjectIds: Array.from(next).sort((a, b) => a - b) })
  }
  function setAutoOpen(id: number | null): void {
    // Switching auto-open off implicitly cancels kiosk mode — locking
    // to nothing makes no sense. Switching it back on doesn't auto-
    // enable kiosk; the admin opts in explicitly.
    onChange({
      ...value,
      autoOpenProjectId: id,
      kioskMode: id === null ? false : value.kioskMode,
    })
  }
  function toggleKiosk(): void {
    onChange({ ...value, kioskMode: !value.kioskMode })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label style={{ display: 'block', marginBottom: 4 }}>Home-screen buttons</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {CAP_LABELS.map(({ key, label, hint }) => (
            <label
              key={key}
              title={hint}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={value.capabilities[key]}
                disabled={disabled}
                onChange={() => toggleCap(key)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 4 }}>
          Project allowlist
          <span className="hint" style={{ marginLeft: 6 }}>
            (Students only see ticked projects. Leave all unticked to grant access to every project.)
          </span>
        </label>
        {projects.length === 0 ? (
          <div className="hint">No projects registered yet. Add one on the Projects page first.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
            {projects.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: disabled ? 0.5 : 1 }}>
                <input
                  type="checkbox"
                  checked={allowSet.has(p.id)}
                  disabled={disabled}
                  onChange={() => toggleAllowedProject(p.id)}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {!hideAutoOpen && (
        <div>
          <label style={{ display: 'block', marginBottom: 4 }}>
            Auto-open on launch
            <span className="hint" style={{ marginLeft: 6 }}>
              (For installs that should land in one project on every launch.)
            </span>
          </label>
          <select
            value={value.autoOpenProjectId ?? ''}
            disabled={disabled}
            onChange={e => setAutoOpen(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— don't auto-open —</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {/* Kiosk mode only makes sense when an auto-open project is
              picked — there's nothing to lock the user into otherwise.
              Hide the checkbox in that state so it can't be ticked into
              a no-op config. */}
          {value.autoOpenProjectId !== null && (
            <label
              title="Lock the desktop into the auto-open project: no welcome screen, no way to switch projects, auto-reopen on close."
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
                opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
                textTransform: 'none', letterSpacing: 0, fontWeight: 400,
              }}
            >
              <input
                type="checkbox"
                checked={value.kioskMode}
                disabled={disabled}
                onChange={toggleKiosk}
              />
              <span>
                Kiosk mode — lock the user into this project (no escape to welcome screen)
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
