import os from 'os'
import * as teamServer from './teamServer'

/**
 * In-app problem reporting.
 *
 * The "Report" button on the error banner sends the error text to the TEAM
 * SERVER, which stores it for the admin web UI's Reports page and optionally
 * forwards it to a Discord/Slack webhook. It is then triaged by a mentor.
 *
 * This replaces the original flow, which shelled out to the GitHub CLI
 * (`gh issue create`). That died with the Git/LFS rip-out: a Drive-only
 * FrameCAD install ships no `gh` and no GitHub sign-in, so the old path failed
 * with "GitHub CLI not found" for every user. There is intentionally no
 * GitHub dependency here anymore.
 */

export interface ReportIssueResult {
  success: boolean
  id?: number
  error?: string
}

export async function reportIssue(errorMessage: string): Promise<ReportIssueResult> {
  const trimmed = (errorMessage || '').trim()
  if (!trimmed) return { success: false, error: 'No error message to report' }

  // The desktop's running version travels as the X-Client-Version header on the
  // request; the server stamps it onto the report. We add OS details here.
  const platform = `${os.platform()} ${os.release()} (${os.arch()})`

  try {
    return await teamServer.reportIssue(trimmed, platform)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
