/**
 * Shared types + helpers for the per-member capability controls.
 * Mirrors the server-side MemberCapabilities shape in db.ts.
 */

export interface MemberCapabilities {
  createProject: boolean
  browseTeamProjects: boolean
  openProject: boolean
  manufacturingView: boolean
  /** "Trusted student": manage the CAD file structure (new part/assembly/
   *  subsystem). Mentors/admins always have it via role. */
  manageCadStructure: boolean
  /** Break (force-release) another member's check-out. Additive on top of
   *  the mentor/admin role grant. */
  forceCheckIn: boolean
}

/** Convenience bundle: every form that edits capabilities edits this
 *  shape, and submits the same fields to the server. */
export interface CapabilityValue {
  capabilities: MemberCapabilities
  allowedProjectIds: number[]
  autoOpenProjectId: number | null
  /** When true (and `autoOpenProjectId` is set), the desktop runs in
   *  kiosk lockdown: welcome screen hidden, project auto-reopens
   *  on close, no escape hatch to other projects. */
  kioskMode: boolean
  /** When true, the desktop becomes a read-only local mirror: it
   *  auto-downloads every project on the allowlist and can never
   *  upload. Independent of kiosk; needs no auto-open project. */
  archiveMode: boolean
}

export interface ProjectOption {
  id: number
  name: string
}

export const EMPTY_CAPABILITY_VALUE: CapabilityValue = {
  capabilities: {
    createProject: false,
    browseTeamProjects: false,
    openProject: false,
    manufacturingView: false,
    manageCadStructure: false,
    forceCheckIn: false,
  },
  allowedProjectIds: [],
  autoOpenProjectId: null,
  kioskMode: false,
  archiveMode: false,
}

export function capCount(c: MemberCapabilities): number {
  return Object.values(c).filter(Boolean).length
}
