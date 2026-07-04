/**
 * Shared "a publish/upload is in flight" flag.
 *
 * Lives in its own tiny module so BOTH publish entry points — the IPC handler
 * (ipc.ts, desktop) and the REST handler (rest.ts, SolidWorks add-in) — can set
 * it, and the main-window close guard (index.ts) can read it, without a circular
 * import between ipc.ts and rest.ts. When true, closing the window warns the
 * user that an upload is in progress so an add-in-triggered publish is protected
 * exactly like a desktop one.
 */
let publishing = false

export function isPublishing(): boolean {
  return publishing
}

export function setPublishing(value: boolean): void {
  publishing = value
}
