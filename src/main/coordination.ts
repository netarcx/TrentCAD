import { app } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import { exec, execFile } from 'child_process'
import os from 'os'
import simpleGit, { SimpleGit } from 'simple-git'
import { getCoordinationRepoUrl, setCoordinationRepoUrl } from './config'
import { getGitHubToken } from './auth'
import type {
  TeamConfig,
  TeamMember,
  ProjectEntry,
  JoinRequest,
  CoordinationState,
  MemberRole,
  MemberStatus
} from '@shared/types'

// ── Input validation (shell-injection prevention) ──

const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/
const SAFE_USERNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/

function assertSafeSlug(value: string, label: string): void {
  if (!SAFE_SLUG.test(value)) throw new Error(`Invalid ${label}: ${value}`)
}

function assertSafeUsername(value: string, label: string): void {
  if (!SAFE_USERNAME.test(value)) throw new Error(`Invalid ${label}: ${value}`)
}

// ── Shell helpers (mirror auth.ts / issue.ts patterns) ──

function run(cmd: string, opts: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    exec(cmd, { timeout: opts.timeout ?? 15000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0
      if (err) {
        const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code
        code = typeof raw === 'number' ? raw : 1
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code })
    })
  })
}

function runGh(ghPath: string, args: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile(ghPath, args, { timeout: opts.timeout ?? 15000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0
      if (err) {
        const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code
        code = typeof raw === 'number' ? raw : 1
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code })
    })
  })
}

async function locateGh(): Promise<string | null> {
  if ((await run('gh --version')).code === 0) return 'gh'
  const candidates: string[] = []
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'))
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'))
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'))
    }
  } else {
    candidates.push('/usr/bin/gh', '/usr/local/bin/gh', '/snap/bin/gh')
    if (process.env.HOME) candidates.push(path.join(process.env.HOME, '.local', 'bin', 'gh'))
    if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/gh')
    else candidates.push('/home/linuxbrew/.linuxbrew/bin/gh')
  }
  for (const c of candidates) {
    try { await fs.access(c); return c } catch { /* keep searching */ }
  }
  return null
}

function q(p: string): string {
  return p.includes(' ') ? `"${p}"` : p
}

// ── Coordination repo local paths ──

function getCoordDir(): string {
  return path.join(app.getPath('userData'), 'coordination')
}

// ── SimpleGit instance for the coordination repo ──

let coordGit: SimpleGit | null = null

function getCoordGit(): SimpleGit {
  if (!coordGit) throw new Error('Coordination repo not initialized')
  return coordGit
}

// ── Write mutex (serialize all mutations) ──

let mutex: Promise<void> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolve: (v: T) => void
  let reject: (e: unknown) => void
  const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  mutex = mutex.then(() => fn().then(resolve!, reject!), () => fn().then(resolve!, reject!))
  return result
}

// ── File I/O helpers ──

async function readCoordFile<T>(filename: string): Promise<T | null> {
  const filePath = path.join(getCoordDir(), filename)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Corrupted coordination file: ${filename}`)
  }
}

async function writeCoordFile(filename: string, data: unknown): Promise<void> {
  const filePath = path.join(getCoordDir(), filename)
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

async function writeCommitAndPush(filename: string, data: unknown, message: string): Promise<void> {
  const g = getCoordGit()

  try {
    await g.fetch('origin')
    const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim()
    try {
      await g.pull('origin', branch, ['--rebase'])
    } catch { /* nothing to pull or conflicts — proceed */ }
  } catch { /* offline or no remote — proceed with local */ }

  await writeCoordFile(filename, data)
  await g.add(filename)

  const status = await g.status()
  if (!status.files.some(f => f.path === filename)) return

  await g.commit(message)

  try {
    await g.push()
  } catch (err) {
    const msg = (err as Error).message
    if (/rejected|non-fast-forward|fetch first/i.test(msg)) {
      try {
        await g.pull(['--rebase'])
        await g.push()
      } catch (retryErr) {
        try { await g.rebase(['--abort']) } catch { /* not mid-rebase */ }
        await g.raw(['reset', '--soft', 'HEAD~1'])
        await g.raw(['reset', '--', filename])
        throw new Error('Could not push coordination update — ' + (retryErr as Error).message)
      }
    } else {
      await g.raw(['reset', '--soft', 'HEAD~1'])
      await g.raw(['reset', '--', filename])
      throw new Error('Could not push coordination update — ' + msg)
    }
  }
}

// ── GitHub username (cached for the session) ──

let cachedGhUser: string | null | undefined
async function getCurrentGitHubUser(): Promise<string | null> {
  if (cachedGhUser !== undefined) return cachedGhUser
  const gh = await locateGh()
  if (!gh) { cachedGhUser = null; return null }
  const result = await run(`${q(gh)} api user --jq .login`)
  cachedGhUser = result.code === 0 && result.stdout ? result.stdout : null
  return cachedGhUser
}

// ── Extract org/repo from coordination repo URL ──

function parseRepoSlug(repoUrl: string): { org: string; repo: string } | null {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  if (!m) return null
  return { org: m[1], repo: m[2] }
}

// ── Core operations ──

async function ensureCloned(repoUrl: string): Promise<SimpleGit> {
  const dir = getCoordDir()

  try {
    await fs.access(path.join(dir, '.git'))
    coordGit = simpleGit(dir)
    // Verify existing clone points at the expected repo
    const existingRemote = (await coordGit.remote(['get-url', 'origin']))?.trim() ?? ''
    const normalise = (u: string) => u.replace(/\.git$/, '').replace(/\/$/, '')
    if (normalise(existingRemote) !== normalise(repoUrl)) {
      await fs.rm(dir, { recursive: true, force: true })
      coordGit = null
    } else {
      try {
        await coordGit.fetch('origin', { '--prune': null })
        const branch = (await coordGit.revparse(['--abbrev-ref', 'HEAD'])).trim()
        await coordGit.pull('origin', branch, ['--rebase', '--autostash'])
      } catch { /* offline — use stale local */ }
      return coordGit
    }
  } catch { /* .git not found — need to clone */ }

  await fs.mkdir(dir, { recursive: true })

  let cloneUrl = repoUrl
  if (cloneUrl.startsWith('https://github.com/')) {
    const token = await getGitHubToken()
    if (token) {
      cloneUrl = cloneUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`)
    }
  }

  try {
    await simpleGit().clone(cloneUrl, dir, ['--single-branch'])
  } catch (err) {
    const msg = (err as Error).message.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
    throw new Error(msg)
  }
  coordGit = simpleGit(dir)

  const remoteUrl = await coordGit.remote(['get-url', 'origin'])
  if (remoteUrl && remoteUrl.trim().includes('@github.com/')) {
    await coordGit.remote(['set-url', 'origin', repoUrl])
  }

  return coordGit
}

async function readFullState(repoUrl: string): Promise<CoordinationState> {
  const team = await readCoordFile<TeamConfig>('team.json')
  const membersFile = await readCoordFile<{ members: TeamMember[] }>('members.json')
  const projectsFile = await readCoordFile<{ projects: ProjectEntry[] }>('projects.json')

  const members = membersFile?.members ?? []
  const projects = projectsFile?.projects?.filter(p => !p.archived) ?? []

  const ghUser = await getCurrentGitHubUser()
  const currentMember = ghUser
    ? members.find(m => m.githubUsername.toLowerCase() === ghUser.toLowerCase())
    : undefined
  const isMember = !!currentMember && currentMember.status === 'active'
  const currentUserRole = currentMember?.role

  let pendingRequests: JoinRequest[] | undefined
  if (currentUserRole === 'admin' || currentUserRole === 'mentor') {
    try {
      pendingRequests = await listJoinRequestsInternal(repoUrl)
    } catch { /* non-fatal */ }
  }

  return {
    configured: true,
    repoUrl,
    team: team ?? undefined,
    members,
    projects,
    isMember,
    currentUserRole,
    pendingRequests,
    lastSyncAt: new Date().toISOString()
  }
}

export async function getCoordinationState(): Promise<CoordinationState> {
  const repoUrl = await getCoordinationRepoUrl()
  if (!repoUrl) return { configured: false }

  try {
    await ensureCloned(repoUrl)
  } catch {
    return { configured: true, repoUrl }
  }

  return readFullState(repoUrl)
}

export async function previewCoordinationRepo(repoUrl: string): Promise<CoordinationState> {
  // ensureCloned handles mismatched remotes by re-cloning
  await ensureCloned(repoUrl)
  const state = await readFullState(repoUrl)
  return { ...state, repoUrl }
}

export async function setupCoordinationRepo(repoUrl: string): Promise<CoordinationState> {
  await ensureCloned(repoUrl)
  await setCoordinationRepoUrl(repoUrl)
  return getCoordinationState()
}

export async function createCoordinationRepo(
  org: string,
  repoName: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  return withLock(async () => {
    const gh = await locateGh()
    if (!gh) return { success: false, error: 'GitHub CLI not found' }
    if (!org || !repoName) return { success: false, error: 'Missing org or repo name' }

    assertSafeSlug(org, 'organization name')
    const safeName = repoName.replace(/[^a-zA-Z0-9._-]/g, '-')
    assertSafeSlug(safeName, 'repo name')

    const desc = 'FrameCAD team coordination repo'
    const result = await runGh(gh, ['repo', 'create', `${org}/${safeName}`, '--public', '--description', desc], { timeout: 30000 })
    if (result.code !== 0) {
      return { success: false, error: result.stderr || result.stdout || 'gh repo create failed' }
    }

    const repoUrl = `https://github.com/${org}/${safeName}.git`
    const dir = getCoordDir()
    try { await fs.rm(dir, { recursive: true, force: true }) } catch { /* clean slate */ }

    // Init locally instead of cloning the empty remote
    await fs.mkdir(dir, { recursive: true })
    const g = simpleGit(dir)
    await g.init()
    await g.addRemote('origin', repoUrl)
    coordGit = g

    const ghUser = await getCurrentGitHubUser()

    const team: TeamConfig = {
      teamName: org,
      gitHubOrg: org,
      projectPrefix: ''
    }
    await writeCoordFile('team.json', team)

    const membersData = {
      members: ghUser ? [{
        githubUsername: ghUser,
        displayName: ghUser,
        role: 'admin' as MemberRole,
        status: 'active' as MemberStatus,
        joinedAt: new Date().toISOString()
      }] : []
    }
    await writeCoordFile('members.json', membersData)

    await writeCoordFile('projects.json', { projects: [] })

    const encodedUrl = encodeURIComponent(repoUrl)
    const readme = [
      `# ${org} — FrameCAD Team Hub`,
      '',
      `[![Join in FrameCAD](https://img.shields.io/badge/Join%20in-FrameCAD-2563eb?style=for-the-badge)](framecad://team?url=${encodedUrl})`,
      '',
      'This repository is managed by FrameCAD. It stores team settings,',
      'member roster, and project registry.',
      '',
      '## How to join',
      '',
      '1. Install [FrameCAD](https://github.com/netarcx/FrameCAD/releases)',
      '2. Click the badge above, or paste this URL in FrameCAD:',
      `   \`${repoUrl}\``,
      '3. Request to join — an admin will approve you',
      ''
    ].join('\n')
    await fs.writeFile(path.join(dir, 'README.md'), readme, 'utf-8')

    const labelResult = await runGh(gh,
      ['label', 'create', 'join-request', '--repo', `${org}/${safeName}`, '--description', 'FrameCAD join requests', '--color', '0E8A16'],
      { timeout: 15000 }
    )
    if (labelResult.code !== 0 && !/already exists/i.test(labelResult.stderr)) {
      console.warn('Could not create join-request label:', labelResult.stderr)
    }

    await g.add(['.'])
    await g.commit('Initialize FrameCAD coordination repo')
    const branch = (await g.branchLocal()).current || 'main'
    try { await g.push('origin', branch, ['--set-upstream']) } catch { /* may already be set */ }

    await setCoordinationRepoUrl(repoUrl)
    return { success: true, url: repoUrl }
  })
}

export async function syncCoordinationRepo(): Promise<CoordinationState> {
  const repoUrl = await getCoordinationRepoUrl()
  if (!repoUrl) return { configured: false }

  try {
    await ensureCloned(repoUrl)
  } catch { /* offline */ }

  return readFullState(repoUrl)
}

export async function disconnectCoordinationRepo(): Promise<void> {
  await setCoordinationRepoUrl(undefined)
  const dir = getCoordDir()
  try { await fs.rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  coordGit = null
}

// ── Join requests (via GitHub issues) ──

export async function requestToJoinTeam(
  displayName: string
): Promise<{ success: boolean; issueNumber?: number; error?: string }> {
  const repoUrl = await getCoordinationRepoUrl()
  if (!repoUrl) return { success: false, error: 'No coordination repo configured' }

  const slug = parseRepoSlug(repoUrl)
  if (!slug) return { success: false, error: 'Could not parse repo URL' }

  const gh = await locateGh()
  if (!gh) return { success: false, error: 'GitHub CLI not found' }

  const ghUser = await getCurrentGitHubUser()
  if (!ghUser) return { success: false, error: 'Not signed into GitHub' }

  const safeDisplayName = displayName.replace(/[^a-zA-Z0-9 ._@()-]/g, '').slice(0, 100)
  const title = `Join Request: ${safeDisplayName} (@${ghUser})`
  const bodyPath = path.join(os.tmpdir(), `framecad-join-${Date.now()}.md`)
  const body = [
    `**GitHub username:** ${ghUser}`,
    `**Display name:** ${displayName}`,
    `**Requested at:** ${new Date().toISOString()}`,
    '',
    'This join request was created by FrameCAD.'
  ].join('\n')

  try {
    await fs.writeFile(bodyPath, body, 'utf-8')
    const titlePath = path.join(os.tmpdir(), `framecad-join-title-${Date.now()}.txt`)
    await fs.writeFile(titlePath, title.slice(0, 200), 'utf-8')
    const issueArgs = ['issue', 'create', '--repo', `${slug.org}/${slug.repo}`, '--title', title.slice(0, 200), '--body-file', bodyPath, '--label', 'join-request']
    const result = await runGh(gh, issueArgs, { timeout: 30000 })
    await fs.unlink(titlePath).catch(() => {})

    if (result.code !== 0) {
      if (/label.+not found|could not add label/i.test(result.stderr + result.stdout)) {
        const fallbackArgs = ['issue', 'create', '--repo', `${slug.org}/${slug.repo}`, '--title', title.slice(0, 200), '--body-file', bodyPath]
        const fallback = await runGh(gh, fallbackArgs, { timeout: 30000 })
        if (fallback.code === 0) return parseIssueResult(fallback.stdout)
        return { success: false, error: fallback.stderr || 'Could not create join request' }
      }
      return { success: false, error: result.stderr || result.stdout || 'Could not create join request' }
    }
    return parseIssueResult(result.stdout)
  } finally {
    fs.unlink(bodyPath).catch(() => {})
  }
}

function parseIssueResult(stdout: string): { success: boolean; issueNumber?: number; error?: string } {
  const url = stdout.split(/\s+/).find(t => /^https:\/\/github\.com\//.test(t))
  if (!url) return { success: true }
  const m = url.match(/\/issues\/(\d+)/)
  return { success: true, issueNumber: m ? Number(m[1]) : undefined }
}

async function listJoinRequestsInternal(repoUrl: string): Promise<JoinRequest[]> {
  const slug = parseRepoSlug(repoUrl)
  if (!slug) return []

  const gh = await locateGh()
  if (!gh) return []

  const result = await runGh(gh,
    ['issue', 'list', '--repo', `${slug.org}/${slug.repo}`, '--label', 'join-request', '--state', 'open', '--json', 'number,title,body,createdAt', '--limit', '50'],
    { timeout: 15000 }
  )
  if (result.code !== 0) return []

  try {
    interface RawIssue { number: number; title: string; body: string; createdAt: string }
    const issues = JSON.parse(result.stdout) as RawIssue[]
    return issues.map(issue => {
      const usernameMatch = issue.body.match(/\*\*GitHub username:\*\*\s*(\S+)/)
      const displayNameMatch = issue.body.match(/\*\*Display name:\*\*\s*(.+)/)
      return {
        issueNumber: issue.number,
        githubUsername: usernameMatch?.[1] ?? 'unknown',
        displayName: displayNameMatch?.[1]?.trim() ?? issue.title.replace(/^Join Request:\s*/i, '').trim(),
        requestedAt: issue.createdAt
      }
    })
  } catch {
    return []
  }
}

export async function getPendingJoinRequests(): Promise<JoinRequest[]> {
  const repoUrl = await getCoordinationRepoUrl()
  if (!repoUrl) return []
  return listJoinRequestsInternal(repoUrl)
}

export async function approveJoinRequest(
  githubUsername: string,
  displayName: string,
  role: MemberRole,
  issueNumber: number
): Promise<{ orgInviteFailed?: boolean }> {
  return withLock(async () => {
    assertSafeUsername(githubUsername, 'GitHub username')
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('Invalid issue number')

    const repoUrl = await getCoordinationRepoUrl()
    if (!repoUrl) throw new Error('No coordination repo configured')

    const slug = parseRepoSlug(repoUrl)
    if (!slug) throw new Error('Could not parse repo URL')

    const membersFile = await readCoordFile<{ members: TeamMember[] }>('members.json')
    const members = membersFile?.members ?? []
    if (!members.some(m => m.githubUsername.toLowerCase() === githubUsername.toLowerCase())) {
      members.push({
        githubUsername,
        displayName: displayName.replace(/[^a-zA-Z0-9 ._@()-]/g, '').slice(0, 100),
        role,
        status: 'active',
        joinedAt: new Date().toISOString()
      })
      await writeCommitAndPush('members.json', { members }, `[team] Approve ${githubUsername}`)
    }

    let orgInviteFailed = false
    const gh = await locateGh()
    if (gh) {
      const inviteResult = await runGh(gh,
        ['api', '-X', 'PUT', `/orgs/${slug.org}/memberships/${githubUsername}`, '-f', 'role=member'],
        { timeout: 15000 }
      )
      if (inviteResult.code !== 0) {
        console.warn(`GitHub org invite failed for ${githubUsername}: ${inviteResult.stderr}`)
        orgInviteFailed = true
      }

      const admin = await getCurrentGitHubUser()
      await runGh(gh,
        ['issue', 'close', String(issueNumber), '--repo', `${slug.org}/${slug.repo}`, '--comment', `Approved by ${admin || 'admin'}`],
        { timeout: 15000 }
      )
    }
    return { orgInviteFailed }
  })
}

export async function denyJoinRequest(issueNumber: number): Promise<void> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('Invalid issue number')

  const repoUrl = await getCoordinationRepoUrl()
  if (!repoUrl) return

  const slug = parseRepoSlug(repoUrl)
  if (!slug) return

  const gh = await locateGh()
  if (!gh) return

  const admin = await getCurrentGitHubUser()
  await runGh(gh,
    ['issue', 'close', String(issueNumber), '--repo', `${slug.org}/${slug.repo}`, '--comment', `Denied by ${admin || 'admin'}`],
    { timeout: 15000 }
  )
}

// ── Member management ──

export async function addTeamMember(member: Omit<TeamMember, 'joinedAt'>): Promise<void> {
  return withLock(async () => {
    assertSafeUsername(member.githubUsername, 'GitHub username')
    const membersFile = await readCoordFile<{ members: TeamMember[] }>('members.json')
    const members = membersFile?.members ?? []
    if (members.some(m => m.githubUsername.toLowerCase() === member.githubUsername.toLowerCase())) {
      throw new Error(`${member.githubUsername} is already a team member`)
    }
    members.push({ ...member, joinedAt: new Date().toISOString() })
    await writeCommitAndPush('members.json', { members }, `[team] Add ${member.githubUsername}`)
  })
}

export async function removeTeamMember(githubUsername: string): Promise<void> {
  return withLock(async () => {
    const membersFile = await readCoordFile<{ members: TeamMember[] }>('members.json')
    const members = (membersFile?.members ?? []).filter(
      m => m.githubUsername.toLowerCase() !== githubUsername.toLowerCase()
    )
    await writeCommitAndPush('members.json', { members }, `[team] Remove ${githubUsername}`)
  })
}

export async function updateTeamMember(
  githubUsername: string,
  updates: Partial<Pick<TeamMember, 'role' | 'status' | 'displayName'>>
): Promise<void> {
  return withLock(async () => {
    const membersFile = await readCoordFile<{ members: TeamMember[] }>('members.json')
    const members = membersFile?.members ?? []
    const member = members.find(m => m.githubUsername.toLowerCase() === githubUsername.toLowerCase())
    if (!member) throw new Error(`Member ${githubUsername} not found`)
    if (updates.role !== undefined) member.role = updates.role
    if (updates.status !== undefined) member.status = updates.status
    if (updates.displayName !== undefined) member.displayName = updates.displayName
    await writeCommitAndPush('members.json', { members }, `[team] Update ${githubUsername}`)
  })
}

// ── Team config ──

export async function saveTeamConfig(config: TeamConfig): Promise<void> {
  return withLock(async () => {
    await writeCommitAndPush('team.json', config, '[team] Update settings')
  })
}

// ── Project registry ──

export async function addProjectToRegistry(project: Omit<ProjectEntry, 'createdAt'>): Promise<void> {
  return withLock(async () => {
    const file = await readCoordFile<{ projects: ProjectEntry[] }>('projects.json')
    const projects = file?.projects ?? []
    if (projects.some(p => p.repoUrl === project.repoUrl)) {
      throw new Error('Project already in registry')
    }
    projects.push({ ...project, createdAt: new Date().toISOString() })
    await writeCommitAndPush('projects.json', { projects }, `[team] Add project ${project.name}`)
  })
}

export async function removeProjectFromRegistry(repoUrl: string): Promise<void> {
  return withLock(async () => {
    const file = await readCoordFile<{ projects: ProjectEntry[] }>('projects.json')
    const projects = (file?.projects ?? []).filter(p => p.repoUrl !== repoUrl)
    await writeCommitAndPush('projects.json', { projects }, '[team] Remove project')
  })
}
