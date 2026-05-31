import path from 'path'
import { promises as fs } from 'fs'
import os from 'os'
import { BrowserWindow } from 'electron'
import { getProjectPath } from './project-paths'
import { loadManifest } from './parts'
import { loadAllMeta } from './meta'
import type { PartEntry, PartMeta, PartsManifest } from '@shared/types'

export type DocType = 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem'

export interface GenerateResult {
  success: boolean
  filePath?: string
  relPath?: string
  pdfFilePath?: string
  pdfRelPath?: string
  /** PDF generation may fail (Electron / printing edge case) while CSV/MD succeeds — surface that separately so the user still gets the source format. */
  pdfError?: string
  error?: string
}

const DOCS_DIR = 'Documents'
const FILES: Record<Exclude<DocType, 'bom-by-subsystem'>, string> = {
  bom: 'BOM.csv',
  manufacturing: 'Manufacturing-Queue.csv',
  summary: 'Project-Summary.md'
}
const PDF_FILES: Record<Exclude<DocType, 'bom-by-subsystem'>, string> = {
  bom: 'BOM.pdf',
  manufacturing: 'Manufacturing-Queue.pdf',
  summary: 'Project-Summary.pdf'
}
const PDF_TITLES: Record<Exclude<DocType, 'bom-by-subsystem'>, string> = {
  bom: 'Bill of Materials',
  manufacturing: 'Manufacturing Queue',
  summary: 'Project Summary'
}
const BOM_BY_SUBSYSTEM_DIR = 'BOM-by-subsystem'
const FRC_WEIGHT_LIMIT_LB = 125

function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function topLevelSegment(p: string): string {
  if (!p) return ''
  const idx = p.indexOf('/')
  return idx === -1 ? p : p.slice(0, idx)
}

function scopeOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? '' : relPath.slice(0, i)
}

function basenameOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? relPath : relPath.slice(i + 1)
}

function dateStamp(d = new Date()): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

interface JoinedRow {
  relPath: string
  entry: PartEntry
  meta: PartMeta
  topLevel: string
}

function joinManifestAndMeta(
  manifest: PartsManifest,
  meta: Record<string, PartMeta>
): JoinedRow[] {
  // Lazy-required so this module doesn't pull in paths.ts at top of file
  // and risk a circular import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { toProjectRel } = require('./paths') as typeof import('./paths')

  const out: JoinedRow[] = []
  for (const [relPath, entry] of Object.entries(manifest.entries)) {
    // Manifest entries are keyed by git-relative paths. For BOM / mfg /
    // summary output, scope to the active project: drop entries that
    // live OUTSIDE the configured projectSubpath (returns null), and
    // rewrite the row's relPath to the subpath-relative form so the
    // CSV/PDF columns don't carry the "2026 Rebuilt/" prefix on every
    // single line. With no subpath, every entry passes through unchanged.
    const displayRel = toProjectRel(relPath)
    if (displayRel === null) continue
    out.push({
      relPath: displayRel,
      entry,
      meta: meta[relPath] || {},
      topLevel: topLevelSegment(displayRel) || '(root)'
    })
  }
  // Group by subsystem then by part number for predictable ordering
  out.sort((a, b) => {
    if (a.topLevel !== b.topLevel) return a.topLevel.localeCompare(b.topLevel)
    return a.entry.partNumber.localeCompare(b.entry.partNumber)
  })
  return out
}

function buildBomCsv(rows: JoinedRow[]): string {
  const header = [
    'Part Number', 'File', 'Type', 'Subsystem', 'Folder',
    'Release Status', 'Manufacturing Method', 'Material',
    'Mass (lb)', 'Cost ($)', 'Comments', 'Path'
  ]
  const lines: string[] = [header.map(csvEscape).join(',')]
  for (const r of rows) {
    lines.push([
      r.entry.partNumber,
      basenameOf(r.relPath),
      r.entry.type,
      r.topLevel,
      scopeOf(r.relPath) || '(root)',
      r.meta.release?.state ?? 'draft',
      r.meta.manufacturingMethod ?? '',
      r.meta.manufacturingMaterial ?? '',
      typeof r.meta.mass === 'number' ? r.meta.mass.toFixed(3) : '',
      typeof r.meta.cost === 'number' ? r.meta.cost.toFixed(2) : '',
      r.meta.comments?.length ?? 0,
      r.relPath
    ].map(csvEscape).join(','))
  }
  return lines.join('\n') + '\n'
}

function buildManufacturingCsv(rows: JoinedRow[]): string {
  // Only released + in-review parts and assemblies; drawings exclude (they
  // share part numbers with their parents). Sort by method, then material,
  // then part number — that's the order a shop wants to walk the list in.
  const queue = rows.filter(r => {
    if (r.entry.type === 'drawing') return false
    const s = r.meta.release?.state
    return s === 'released' || s === 'in-review'
  })
  queue.sort((a, b) => {
    const ma = a.meta.manufacturingMethod || 'zzz'
    const mb = b.meta.manufacturingMethod || 'zzz'
    if (ma !== mb) return ma.localeCompare(mb)
    const mata = a.meta.manufacturingMaterial || ''
    const matb = b.meta.manufacturingMaterial || ''
    if (mata !== matb) return mata.localeCompare(matb)
    return a.entry.partNumber.localeCompare(b.entry.partNumber)
  })

  const header = [
    'Method', 'Material', 'Part Number', 'File', 'Subsystem',
    'Type', 'Status', 'Mass (lb)', 'Notes'
  ]
  const lines: string[] = [header.map(csvEscape).join(',')]
  for (const r of queue) {
    lines.push([
      r.meta.manufacturingMethod ?? '(unassigned)',
      r.meta.manufacturingMaterial ?? '',
      r.entry.partNumber,
      basenameOf(r.relPath),
      r.topLevel,
      r.entry.type,
      r.meta.release?.state ?? '',
      typeof r.meta.mass === 'number' ? r.meta.mass.toFixed(3) : '',
      r.meta.manufacturingNotes ?? ''
    ].map(csvEscape).join(','))
  }
  return lines.join('\n') + '\n'
}

function buildSummaryMarkdown(
  rows: JoinedRow[],
  generatedBy: string
): string {
  // By-subsystem rollup
  const bySub = new Map<string, {
    parts: number; released: number; manufactured: number
    mass: number; cost: number
  }>()
  // By-method rollup (released + in-review only — the actual shop work)
  const byMethod = new Map<string, { parts: number; mass: number; cost: number }>()

  let totalMass = 0
  let totalCost = 0
  let totalParts = 0
  let totalReleased = 0
  let totalManufactured = 0

  for (const r of rows) {
    if (r.entry.type === 'drawing') continue
    totalParts++
    const state = r.meta.release?.state
    if (state === 'released') totalReleased++
    if (state === 'manufactured') totalManufactured++

    const mass = r.meta.mass ?? 0
    const cost = r.meta.cost ?? 0
    totalMass += mass
    totalCost += cost

    const sub = bySub.get(r.topLevel) || { parts: 0, released: 0, manufactured: 0, mass: 0, cost: 0 }
    sub.parts++
    if (state === 'released') sub.released++
    if (state === 'manufactured') sub.manufactured++
    sub.mass += mass
    sub.cost += cost
    bySub.set(r.topLevel, sub)

    if (state === 'released' || state === 'in-review') {
      const method = r.meta.manufacturingMethod || '(unassigned)'
      const m = byMethod.get(method) || { parts: 0, mass: 0, cost: 0 }
      m.parts++
      m.mass += mass
      m.cost += cost
      byMethod.set(method, m)
    }
  }

  const massPct = (totalMass / FRC_WEIGHT_LIMIT_LB) * 100
  const massHeadroom = FRC_WEIGHT_LIMIT_LB - totalMass

  const lines: string[] = []
  lines.push(`# Project Summary`)
  lines.push('')
  lines.push(`*Generated ${dateStamp()} by ${generatedBy || 'FrameCAD'}*`)
  lines.push('')
  lines.push(`## Totals`)
  lines.push('')
  lines.push(`- **Mass:** ${totalMass.toFixed(2)} lb of ${FRC_WEIGHT_LIMIT_LB} lb FRC limit — ` +
    `${massHeadroom >= 0 ? `${massHeadroom.toFixed(2)} lb headroom` : `**${(-massHeadroom).toFixed(2)} lb over**`} (${massPct.toFixed(1)}%)`)
  lines.push(`- **Estimated Cost:** ${formatMoney(totalCost)}`)
  lines.push(`- **Parts:** ${totalParts} total / ${totalReleased} released / ${totalManufactured} manufactured`)
  lines.push('')

  if (bySub.size > 0) {
    lines.push(`## By Subsystem`)
    lines.push('')
    lines.push(`| Subsystem | Parts | Released | Manufactured | Mass (lb) | Cost |`)
    lines.push(`|---|---|---|---|---|---|`)
    const subsystems = [...bySub.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [name, s] of subsystems) {
      lines.push(`| ${name} | ${s.parts} | ${s.released} | ${s.manufactured} | ${s.mass.toFixed(2)} | ${formatMoney(s.cost)} |`)
    }
    lines.push('')
  }

  if (byMethod.size > 0) {
    lines.push(`## Shop Work by Method *(released + in-review)*`)
    lines.push('')
    lines.push(`| Method | Parts | Mass (lb) | Cost |`)
    lines.push(`|---|---|---|---|`)
    const methods = [...byMethod.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [name, m] of methods) {
      lines.push(`| ${name} | ${m.parts} | ${m.mass.toFixed(2)} | ${formatMoney(m.cost)} |`)
    }
    lines.push('')
  }

  lines.push(`---`)
  lines.push(`<sub>Detailed part-by-part data is in \`BOM.csv\`; shop-floor cut list is in \`Manufacturing-Queue.csv\`.</sub>`)
  lines.push('')
  return lines.join('\n')
}

function escapeHtml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PDF_BASE_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; font-size: 10.5px; margin: 0; padding: 32px 28px; }
  h1 { font-size: 22px; margin: 0 0 4px 0; }
  h2 { font-size: 14px; margin: 24px 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid #d4d4d4; }
  h3 { font-size: 12px; margin: 16px 0 6px 0; color: #444; }
  .meta { font-size: 10px; color: #666; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5px; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; page-break-after: auto; }
  th, td { padding: 5px 7px; border-bottom: 1px solid #eaeaea; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; font-weight: 600; border-bottom: 1px solid #c0c0c0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Part numbers (e.g. "26-2129-01-005") must stay on one line — they're
     hyphenated which would otherwise let the browser wrap inside the
     number when a tight page column shrinks the cell width. */
  td.pn, th.pn { white-space: nowrap; font-family: 'SF Mono', Consolas, Menlo, monospace; }
  .badge { padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; white-space: nowrap; }
  .badge-released { background: #d1fae5; color: #065f46; }
  .badge-in-review { background: #fef3c7; color: #92400e; }
  .badge-draft { background: #f3f4f6; color: #4b5563; }
  .badge-manufactured { background: #dbeafe; color: #1e40af; }
  .totals { font-size: 12px; line-height: 1.7; margin: 8px 0 16px; }
  .totals strong { display: inline-block; min-width: 160px; }
  .over-limit { color: #b91c1c; font-weight: 600; }
  .footer { margin-top: 20px; font-size: 9px; color: #888; }
`

function htmlShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PDF_BASE_STYLES}</style></head><body>${bodyHtml}</body></html>`
}

function badgeFor(state?: string): string {
  if (!state) return '<span class="badge badge-draft">draft</span>'
  return `<span class="badge badge-${escapeHtml(state)}">${escapeHtml(state)}</span>`
}

function buildBomHtml(rows: JoinedRow[], generatedBy: string): string {
  const tableRows = rows.map(r => `<tr>
    <td class="pn"><strong>${escapeHtml(r.entry.partNumber)}</strong></td>
    <td>${escapeHtml(basenameOf(r.relPath))}</td>
    <td>${escapeHtml(r.entry.type)}</td>
    <td>${escapeHtml(r.topLevel)}</td>
    <td>${badgeFor(r.meta.release?.state)}</td>
    <td>${escapeHtml(r.meta.manufacturingMethod ?? '')}</td>
    <td>${escapeHtml(r.meta.manufacturingMaterial ?? '')}</td>
    <td class="num">${typeof r.meta.mass === 'number' ? r.meta.mass.toFixed(3) : ''}</td>
    <td class="num">${typeof r.meta.cost === 'number' ? r.meta.cost.toFixed(2) : ''}</td>
  </tr>`).join('')
  const body = `
    <h1>Bill of Materials</h1>
    <div class="meta">Generated ${dateStamp()} by ${escapeHtml(generatedBy || 'FrameCAD')} · ${rows.length} entries</div>
    <table>
      <thead><tr>
        <th class="pn">Part #</th><th>File</th><th>Type</th><th>Subsystem</th>
        <th>Status</th><th>Method</th><th>Material</th>
        <th class="num">Mass (lb)</th><th class="num">Cost ($)</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `
  return htmlShell('Bill of Materials', body)
}

function buildManufacturingHtml(rows: JoinedRow[], generatedBy: string): string {
  const queue = rows.filter(r => {
    if (r.entry.type === 'drawing') return false
    const s = r.meta.release?.state
    return s === 'released' || s === 'in-review'
  })

  // Group by method
  const byMethod = new Map<string, JoinedRow[]>()
  for (const r of queue) {
    const m = r.meta.manufacturingMethod || '(unassigned)'
    if (!byMethod.has(m)) byMethod.set(m, [])
    byMethod.get(m)!.push(r)
  }

  const sections = [...byMethod.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([method, list]) => {
    list.sort((a, b) => {
      const mata = a.meta.manufacturingMaterial || ''
      const matb = b.meta.manufacturingMaterial || ''
      if (mata !== matb) return mata.localeCompare(matb)
      return a.entry.partNumber.localeCompare(b.entry.partNumber)
    })
    const tableRows = list.map(r => `<tr>
      <td class="pn"><strong>${escapeHtml(r.entry.partNumber)}</strong></td>
      <td>${escapeHtml(basenameOf(r.relPath))}</td>
      <td>${escapeHtml(r.meta.manufacturingMaterial ?? '')}</td>
      <td>${escapeHtml(r.topLevel)}</td>
      <td>${badgeFor(r.meta.release?.state)}</td>
      <td class="num">${typeof r.meta.mass === 'number' ? r.meta.mass.toFixed(3) : ''}</td>
      <td>${escapeHtml(r.meta.manufacturingNotes ?? '')}</td>
    </tr>`).join('')
    return `
      <h2>${escapeHtml(method)} <span style="font-weight:400;color:#666;font-size:12px">(${list.length})</span></h2>
      <table>
        <thead><tr>
          <th class="pn">Part #</th><th>File</th><th>Material</th><th>Subsystem</th>
          <th>Status</th><th class="num">Mass (lb)</th><th>Notes</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `
  }).join('')

  const body = `
    <h1>Manufacturing Queue</h1>
    <div class="meta">Generated ${dateStamp()} by ${escapeHtml(generatedBy || 'FrameCAD')} · ${queue.length} parts in queue (released + in-review)</div>
    ${queue.length === 0 ? '<p>Nothing in the queue yet — no parts are marked released or in-review.</p>' : sections}
  `
  return htmlShell('Manufacturing Queue', body)
}

function buildSummaryHtml(rows: JoinedRow[], generatedBy: string): string {
  // Reuse the same rollups as the markdown builder
  const bySub = new Map<string, { parts: number; released: number; manufactured: number; mass: number; cost: number }>()
  const byMethod = new Map<string, { parts: number; mass: number; cost: number }>()
  let totalMass = 0, totalCost = 0, totalParts = 0, totalReleased = 0, totalManufactured = 0

  for (const r of rows) {
    if (r.entry.type === 'drawing') continue
    totalParts++
    const state = r.meta.release?.state
    if (state === 'released') totalReleased++
    if (state === 'manufactured') totalManufactured++
    const mass = r.meta.mass ?? 0
    const cost = r.meta.cost ?? 0
    totalMass += mass
    totalCost += cost
    const sub = bySub.get(r.topLevel) || { parts: 0, released: 0, manufactured: 0, mass: 0, cost: 0 }
    sub.parts++
    if (state === 'released') sub.released++
    if (state === 'manufactured') sub.manufactured++
    sub.mass += mass
    sub.cost += cost
    bySub.set(r.topLevel, sub)
    if (state === 'released' || state === 'in-review') {
      const method = r.meta.manufacturingMethod || '(unassigned)'
      const m = byMethod.get(method) || { parts: 0, mass: 0, cost: 0 }
      m.parts++
      m.mass += mass
      m.cost += cost
      byMethod.set(method, m)
    }
  }

  const massPct = (totalMass / FRC_WEIGHT_LIMIT_LB) * 100
  const massHeadroom = FRC_WEIGHT_LIMIT_LB - totalMass
  const overLimit = massHeadroom < 0

  const subsHtml = [...bySub.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, s]) => `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td class="num">${s.parts}</td>
      <td class="num">${s.released}</td>
      <td class="num">${s.manufactured}</td>
      <td class="num">${s.mass.toFixed(2)}</td>
      <td class="num">${formatMoney(s.cost)}</td>
    </tr>`).join('')

  const methodsHtml = [...byMethod.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, m]) => `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td class="num">${m.parts}</td>
      <td class="num">${m.mass.toFixed(2)}</td>
      <td class="num">${formatMoney(m.cost)}</td>
    </tr>`).join('')

  const body = `
    <h1>Project Summary</h1>
    <div class="meta">Generated ${dateStamp()} by ${escapeHtml(generatedBy || 'FrameCAD')}</div>

    <div class="totals">
      <div><strong>Mass:</strong> ${totalMass.toFixed(2)} lb of ${FRC_WEIGHT_LIMIT_LB} lb FRC limit
        ${overLimit
          ? `<span class="over-limit">— ${(-massHeadroom).toFixed(2)} lb OVER</span>`
          : `— ${massHeadroom.toFixed(2)} lb headroom`} (${massPct.toFixed(1)}%)
      </div>
      <div><strong>Estimated Cost:</strong> ${formatMoney(totalCost)}</div>
      <div><strong>Parts:</strong> ${totalParts} total / ${totalReleased} released / ${totalManufactured} manufactured</div>
    </div>

    ${bySub.size === 0 ? '' : `
      <h2>By Subsystem</h2>
      <table>
        <thead><tr>
          <th>Subsystem</th><th class="num">Parts</th><th class="num">Released</th>
          <th class="num">Manufactured</th><th class="num">Mass (lb)</th><th class="num">Cost</th>
        </tr></thead>
        <tbody>${subsHtml}</tbody>
      </table>
    `}

    ${byMethod.size === 0 ? '' : `
      <h2>Shop Work by Method <span style="font-weight:400;font-size:11px;color:#666">(released + in-review)</span></h2>
      <table>
        <thead><tr>
          <th>Method</th><th class="num">Parts</th><th class="num">Mass (lb)</th><th class="num">Cost</th>
        </tr></thead>
        <tbody>${methodsHtml}</tbody>
      </table>
    `}

    <div class="footer">Detailed part-by-part data is in BOM.pdf / BOM.csv; shop-floor cut list is in Manufacturing-Queue.pdf / .csv.</div>
  `
  return htmlShell('Project Summary', body)
}

/**
 * Render HTML to PDF via a hidden BrowserWindow + Chromium's print
 * engine. Returns the PDF bytes. Uses a temp file for the HTML source
 * because data: URLs balloon for large documents and some Chromium
 * versions truncate them.
 *
 * The header (title + generated date) and footer (Page X of Y) show on
 * EVERY page. Chromium's `headerTemplate` / `footerTemplate` placeholder
 * spans (`<span class="title">`, `<span class="pageNumber">`, etc.) are
 * substituted at print time. The templates also need their own inline
 * styles because they don't inherit the body's stylesheet.
 */
async function htmlToPdf(html: string, title: string): Promise<Buffer> {
  const tmpHtmlPath = path.join(os.tmpdir(), `framecad-doc-${Date.now()}.html`)
  await fs.writeFile(tmpHtmlPath, html, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  const escapedTitle = escapeHtml(title)
  const dateLabel = `Generated ${dateStamp()}`
  const headerTemplate = `
    <div style="font-size:9px;color:#666;width:100%;padding:0 0.4in;display:flex;justify-content:space-between;font-family:-apple-system,'Segoe UI',sans-serif;-webkit-print-color-adjust:exact;">
      <span>${escapedTitle}</span>
      <span>${escapeHtml(dateLabel)}</span>
    </div>`
  const footerTemplate = `
    <div style="font-size:9px;color:#666;width:100%;padding:0 0.4in;text-align:right;font-family:-apple-system,'Segoe UI',sans-serif;-webkit-print-color-adjust:exact;">
      Page <span class="pageNumber"></span> of <span class="totalPages"></span>
    </div>`

  try {
    await win.loadFile(tmpHtmlPath)
    // Give Chromium one extra tick after did-finish-load to ensure
    // layout has settled. printToPDF before layout completes can clip
    // long tables.
    await new Promise(r => setTimeout(r, 100))
    const pdf = await win.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      // Top/bottom margins enlarged so the header/footer have room.
      // 0.6in top fits the ~9px header band; 0.5in bottom fits the page
      // number band with breathing room above it.
      margins: { top: 0.6, bottom: 0.5, left: 0.4, right: 0.4 } as never
    })
    return pdf
  } finally {
    win.destroy()
    fs.unlink(tmpHtmlPath).catch(() => { /* best-effort */ })
  }
}

export async function generateDocument(type: DocType, generatedBy: string): Promise<GenerateResult> {
  try {
    const projectDir = getProjectPath()
    const manifest = await loadManifest()
    const meta = await loadAllMeta()
    const rows = joinManifestAndMeta(manifest, meta)

    // BOM-by-subsystem produces N files (one per top-level folder)
    // rather than a single combined document. Path return values point
    // at the containing folder so "Open" in the UI reveals all the
    // PDFs the user just generated.
    if (type === 'bom-by-subsystem') {
      const subsystems = new Map<string, JoinedRow[]>()
      for (const r of rows) {
        const sub = r.topLevel || '(root)'
        if (!subsystems.has(sub)) subsystems.set(sub, [])
        subsystems.get(sub)!.push(r)
      }
      const outDir = path.join(projectDir, DOCS_DIR, BOM_BY_SUBSYSTEM_DIR)
      await fs.mkdir(outDir, { recursive: true })
      let pdfFailures = 0
      let count = 0
      for (const [sub, subRows] of subsystems) {
        const safeName = sub.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-')
        const csvPath = path.join(outDir, `BOM-${safeName}.csv`)
        await fs.writeFile(csvPath, buildBomCsv(subRows), 'utf-8')
        try {
          const subHtml = buildBomHtml(subRows, generatedBy)
            .replace('<h1>Bill of Materials</h1>', `<h1>Bill of Materials — ${escapeHtml(sub)}</h1>`)
          const pdfBuf = await htmlToPdf(subHtml, `BOM — ${sub}`)
          await fs.writeFile(path.join(outDir, `BOM-${safeName}.pdf`), pdfBuf)
        } catch {
          pdfFailures++
        }
        count++
      }
      const relOutDir = `${DOCS_DIR}/${BOM_BY_SUBSYSTEM_DIR}`
      return {
        success: true,
        filePath: outDir,
        relPath: relOutDir,
        pdfFilePath: pdfFailures < count ? outDir : undefined,
        pdfRelPath: pdfFailures < count ? relOutDir : undefined,
        pdfError: pdfFailures > 0 ? `${pdfFailures} of ${count} PDFs failed; CSVs all wrote OK` : undefined
      }
    }

    // narrow type — TypeScript can't infer that bom-by-subsystem was
    // handled above, so explicitly assert
    const t = type as Exclude<DocType, 'bom-by-subsystem'>

    let content: string
    let html: string
    switch (t) {
      case 'bom':
        content = buildBomCsv(rows)
        html = buildBomHtml(rows, generatedBy)
        break
      case 'manufacturing':
        content = buildManufacturingCsv(rows)
        html = buildManufacturingHtml(rows, generatedBy)
        break
      case 'summary':
        content = buildSummaryMarkdown(rows, generatedBy)
        html = buildSummaryHtml(rows, generatedBy)
        break
    }

    const relPath = `${DOCS_DIR}/${FILES[t]}`
    const absPath = path.join(projectDir, DOCS_DIR, FILES[t])
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')

    // PDF is best-effort — if it fails, we still return the source-file
    // path so the user can use the CSV/MD. PDF errors come back in
    // pdfError without flipping the top-level success flag.
    const pdfRelPath = `${DOCS_DIR}/${PDF_FILES[t]}`
    const pdfAbsPath = path.join(projectDir, DOCS_DIR, PDF_FILES[t])
    let pdfError: string | undefined
    try {
      const pdfBuf = await htmlToPdf(html, PDF_TITLES[t])
      await fs.writeFile(pdfAbsPath, pdfBuf)
    } catch (err) {
      pdfError = (err as Error).message
    }

    return {
      success: true,
      filePath: absPath,
      relPath,
      pdfFilePath: pdfError ? undefined : pdfAbsPath,
      pdfRelPath: pdfError ? undefined : pdfRelPath,
      pdfError
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
