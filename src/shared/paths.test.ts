import { describe, it, expect } from 'vitest'
import { projectDirName, joinTargetDir } from './paths'

describe('projectDirName', () => {
  it('passes ordinary names through', () => {
    expect(projectDirName('2026-Robot')).toBe('2026-Robot')
    expect(projectDirName('26-2129 Chassis')).toBe('26-2129 Chassis')
  })

  it('strips Windows-forbidden characters', () => {
    expect(projectDirName('Robot: <v2>?')).toBe('Robot v2')
    expect(projectDirName('a/b\\c|d*e"f')).toBe('a b c d e f')
  })

  it('trims trailing dots and spaces (illegal on Windows)', () => {
    expect(projectDirName('Robot.')).toBe('Robot')
    expect(projectDirName('Robot. . ')).toBe('Robot')
  })

  it('collapses runs of whitespace', () => {
    expect(projectDirName('  Big   Robot  ')).toBe('Big Robot')
  })

  it('returns empty string when nothing survives', () => {
    expect(projectDirName('???')).toBe('')
    expect(projectDirName('')).toBe('')
  })

  it('caps length at 80', () => {
    expect(projectDirName('x'.repeat(200))).toHaveLength(80)
  })
})

describe('joinTargetDir', () => {
  it('appends a per-project subfolder to the picked location', () => {
    expect(joinTargetDir('C:\\framecad', 'Robot', 'id123')).toBe('C:\\framecad\\Robot')
    expect(joinTargetDir('/home/team/cad', 'Robot', 'id123')).toBe('/home/team/cad/Robot')
  })

  it('detects the separator from the save path', () => {
    expect(joinTargetDir('C:\\framecad\\', 'Robot', 'id123')).toBe('C:\\framecad\\Robot')
    expect(joinTargetDir('/srv/cad/', 'Robot', 'id123')).toBe('/srv/cad/Robot')
  })

  it('honors an explicit separator (what the main process passes)', () => {
    expect(joinTargetDir('/srv/cad', 'Robot', 'id123', '/')).toBe('/srv/cad/Robot')
  })

  it('uses the picked folder as-is when it is already named like the project', () => {
    expect(joinTargetDir('C:\\framecad\\Robot', 'Robot', 'id123')).toBe('C:\\framecad\\Robot')
    expect(joinTargetDir('C:\\framecad\\robot', 'Robot', 'id123')).toBe('C:\\framecad\\robot')
  })

  it('sanitizes the project name before appending', () => {
    expect(joinTargetDir('/srv/cad', 'Robot: v2?', 'id123')).toBe('/srv/cad/Robot v2')
  })

  it('falls back to the Drive folder id when the name sanitizes to nothing', () => {
    expect(joinTargetDir('/srv/cad', '???', 'id123')).toBe('/srv/cad/id123')
  })
})
