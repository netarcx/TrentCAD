/**
 * Shared types + helpers for the per-member capability controls.
 * Mirrors the server-side MemberCapabilities shape in db.ts.
 */

export interface MemberCapabilities {
  createProject: boolean
  browseTeamProjects: boolean
  openProject: boolean
  manufacturingView: boolean
}

/** Convenience bundle: every form that edits capabilities edits this
 *  shape, and submits the same three fields to the server. */
export interface CapabilityValue {
  capabilities: MemberCapabilities
  allowedProjectIds: number[]
  autoOpenProjectId: number | null
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
  },
  allowedProjectIds: [],
  autoOpenProjectId: null,
}

export function capCount(c: MemberCapabilities): number {
  return Object.values(c).filter(Boolean).length
}
