// @vitest-environment node
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { ActivityRecordingSaveError, activityRecordingName, cleanCpuProfile, OUTSIDE_SOTTO, pruneActivityRecordings, recordingFileSystem, saveActivityRecording, sottoScriptUrl, sweepPartialActivityRecordings, type RawCpuProfile, type RecordingFileSystem } from '../../../src/main/performance/activityRecorder'

const APP = process.platform === 'win32' ? 'C:\\Users\\someone\\AppData\\Local\\Programs\\Sotto\\resources\\app.asar' : '/Applications/Sotto.app/Contents/Resources/app.asar'
const mainScript = join(APP, 'out', 'main', 'index.js')

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-activity-'))
  folders.push(folder)
  return folder
}

const reading = { blockedShare: 0.7, longestFreezeMs: 1_900, freezesOver100ms: 23, bars: [0, 1_000] }

function rawProfile(): RawCpuProfile {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 3, 4] },
      { id: 2, callFrame: { functionName: 'publish', scriptId: '12', url: pathToFileURL(mainScript).href, lineNumber: 91_332, columnNumber: 4 }, hitCount: 40, children: [],
        positionTicks: [{ line: 91_333, ticks: 40 }], deoptReason: 'Optimized too many times' },
      { id: 3, callFrame: { functionName: 'readFileSync', scriptId: '7', url: 'node:fs', lineNumber: 400, columnNumber: 2 }, hitCount: 3, children: [] },
      { id: 4, callFrame: { functionName: 'leakMyPrompt', scriptId: '99', url: 'https://example.com/the-users-page.js?q=secret', lineNumber: 1, columnNumber: 1 }, hitCount: 9, children: [] },
    ],
    startTime: 100, endTime: 60_000_100, samples: [2, 2, 3, 4], timeDeltas: [1_000, 1_000, 1_000, 1_000],
  }
}

describe('sottoScriptUrl', () => {
  it('keeps built-in modules by name and Sotto\'s own scripts relative to the app, with no folder of this computer', () => {
    expect(sottoScriptUrl('node:internal/timers', [APP])).toBe('node:internal/timers')
    expect(sottoScriptUrl('electron/js2c/browser_init', [APP])).toBe('electron/js2c/browser_init')
    expect(sottoScriptUrl(pathToFileURL(mainScript).href, [APP])).toBe('sotto:///out/main/index.js')
    expect(sottoScriptUrl(mainScript, [APP])).toBe('sotto:///out/main/index.js')
    expect(sottoScriptUrl('http://localhost:5173/src/main.tsx?t=1', [APP], ['http://localhost:5173'])).toBe('sotto:///src/main.tsx')
  })

  it('refuses anything else: other pages, other folders, relative paths, data and code with no address', () => {
    expect(sottoScriptUrl('', [APP])).toBeNull()
    expect(sottoScriptUrl('https://example.com/x.js', [APP])).toBeNull()
    expect(sottoScriptUrl('about:srcdoc', [APP])).toBeNull()
    expect(sottoScriptUrl('data:text/javascript,alert(1)', [APP])).toBeNull()
    expect(sottoScriptUrl(join(APP, '..', 'elsewhere.js'), [APP])).toBeNull()
    expect(sottoScriptUrl('out/main/index.js', [APP])).toBeNull()
    expect(sottoScriptUrl('http://localhost:5174/src/main.tsx', [APP], ['http://localhost:5173'])).toBeNull()
  })
})

describe('cleanCpuProfile', () => {
  it('keeps names, Sotto\'s script places and timings, and nothing else', () => {
    const clean = cleanCpuProfile(rawProfile(), [APP])
    expect(Object.keys(clean).sort()).toEqual(['endTime', 'nodes', 'samples', 'startTime', 'timeDeltas'])
    for (const node of clean.nodes) {
      expect(Object.keys(node).sort()).toEqual(['callFrame', 'children', 'hitCount', 'id'])
      expect(Object.keys(node.callFrame).sort()).toEqual(['columnNumber', 'functionName', 'lineNumber', 'scriptId', 'url'])
    }
    expect(clean.nodes[1]!.callFrame).toEqual({ functionName: 'publish', scriptId: '12', url: 'sotto:///out/main/index.js', lineNumber: 91_332, columnNumber: 4 })
    expect(clean.nodes[2]!.callFrame.url).toBe('node:fs')
    expect(clean.samples).toEqual([2, 2, 3, 4])
    expect(clean.timeDeltas).toEqual([1_000, 1_000, 1_000, 1_000])
  })

  it('renames a frame from outside Sotto, so neither its name nor its address is kept', () => {
    const outside = cleanCpuProfile(rawProfile(), [APP]).nodes[3]!
    expect(outside.callFrame).toEqual({ functionName: OUTSIDE_SOTTO, scriptId: '0', url: OUTSIDE_SOTTO, lineNumber: -1, columnNumber: -1 })
    expect(outside.hitCount).toBe(9)
    const text = JSON.stringify(cleanCpuProfile(rawProfile(), [APP]))
    expect(text).not.toContain('leakMyPrompt')
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('positionTicks')
    expect(text).not.toContain('Optimized')
    expect(text).not.toContain('someone')
  })

  it('treats a frame with no script address as outside Sotto, except V8\'s own frames', () => {
    // Code evaluated from text has an empty URL, and its function names can be the text's own words.
    const raw: RawCpuProfile = { nodes: [
      { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 3, 4, 5, 6] },
      { id: 2, callFrame: { functionName: '(program)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 5, children: [] },
      { id: 3, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 5, children: [] },
      { id: 4, callFrame: { functionName: '(garbage collector)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 5, children: [] },
      { id: 5, callFrame: { functionName: 'pleaseSummariseMyPrivateNoteCanary', scriptId: '41', url: '', lineNumber: 0, columnNumber: 9 }, hitCount: 7, children: [] },
      { id: 6, callFrame: { functionName: 'unknownScriptCanary', scriptId: '42', url: 'evalmachine.<anonymous>', lineNumber: 3, columnNumber: 1 }, hitCount: 2, children: [] },
    ] }
    const clean = cleanCpuProfile(raw, [APP])
    expect(clean.nodes.slice(0, 4).map(node => [node.callFrame.functionName, node.callFrame.url])).toEqual([
      ['(root)', ''], ['(program)', ''], ['(idle)', ''], ['(garbage collector)', ''],
    ])
    expect(clean.nodes[4]!.callFrame).toEqual({ functionName: OUTSIDE_SOTTO, scriptId: '0', url: OUTSIDE_SOTTO, lineNumber: -1, columnNumber: -1 })
    expect(clean.nodes[4]!.hitCount).toBe(7)
    expect(clean.nodes[5]!.callFrame.functionName).toBe(OUTSIDE_SOTTO)
    const text = JSON.stringify(clean)
    expect(text).not.toContain('Canary')
    expect(text).not.toContain('evalmachine')
  })

  it('reads a malformed profile without throwing', () => {
    expect(cleanCpuProfile({ nodes: [null, 'x', { callFrame: { url: 7 } }] as unknown[] }, [APP]).nodes).toHaveLength(1)
  })
})

describe('saving and keeping recordings', () => {
  const summary = { format: 1 as const, sottoVersion: '0.1.38-owl.20261020.1', platform: 'win32', startedAt: '2026-10-20T14:32:05.000Z', durationMs: 60_000, before: reading, during: reading }

  it('writes main\'s profile, the window\'s and a summary with only the numbers', async () => {
    const directory = join(await scratch(), 'performance-recordings')
    const clean = cleanCpuProfile(rawProfile(), [APP])
    const saved = await saveActivityRecording(directory, 'sotto-activity-2026-10-20-14-32-05', { main: clean, window: clean }, summary)
    expect(saved!.files).toEqual(['main.cpuprofile', 'window.cpuprofile', 'summary.json'])
    expect((await readdir(saved!.folder)).sort()).toEqual(['main.cpuprofile', 'summary.json', 'window.cpuprofile'])
    expect(saved!.bytes).toBeGreaterThan(0)
    const written = JSON.parse(await readFile(join(saved!.folder, 'summary.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(['before', 'durationMs', 'during', 'files', 'format', 'platform', 'sottoVersion', 'startedAt', 'windowRecorded'])
    expect(Object.keys(written['before'] as object).sort()).toEqual(['bars', 'blockedShare', 'freezesOver100ms', 'longestFreezeMs'])
    const profile = JSON.parse(await readFile(join(saved!.folder, 'main.cpuprofile'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(profile).sort()).toEqual(['endTime', 'nodes', 'samples', 'startTime', 'timeDeltas'])
  })

  it('keeps main\'s profile alone when the window could not be recorded', async () => {
    const directory = await scratch()
    const saved = await saveActivityRecording(directory, 'sotto-activity-2026-10-20-14-32-05', { main: cleanCpuProfile(rawProfile(), [APP]), window: null }, summary)
    expect(saved!.files).toEqual(['main.cpuprofile', 'summary.json'])
    expect(JSON.parse(await readFile(join(saved!.folder, 'summary.json'), 'utf8'))).toMatchObject({ windowRecorded: false, files: ['main.cpuprofile', 'summary.json'] })
  })

  it('never writes over an earlier recording from the same second', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    const first = await saveActivityRecording(directory, 'sotto-activity-2026-10-20-14-32-05', { main: clean, window: null }, summary)
    const second = await saveActivityRecording(directory, 'sotto-activity-2026-10-20-14-32-05', { main: clean, window: null }, summary)
    expect(second!.name).toBe('sotto-activity-2026-10-20-14-32-05-2')
    expect(second!.folder).not.toBe(first!.folder)
  })

  it('keeps only the newest five recordings and clears half-written ones, leaving other files alone', async () => {
    const directory = await scratch()
    for (let minute = 10; minute < 17; minute += 1) await mkdir(join(directory, `sotto-activity-2026-10-20-14-${minute}-00`))
    await mkdir(join(directory, 'sotto-activity-2026-10-20-14-09-00.partial'))
    await mkdir(join(directory, 'something-else'))
    const removed = await pruneActivityRecordings(directory)
    expect(removed).toEqual(['sotto-activity-2026-10-20-14-10-00', 'sotto-activity-2026-10-20-14-11-00', 'sotto-activity-2026-10-20-14-09-00.partial'])
    expect((await readdir(directory)).sort()).toEqual(['something-else', ...[12, 13, 14, 15, 16].map(minute => `sotto-activity-2026-10-20-14-${minute}-00`)])
  })

  /** The real file operations, with `fail` deciding which call throws. */
  function failing(fail: (operation: keyof RecordingFileSystem, path: string, call: number) => boolean): RecordingFileSystem {
    const calls = new Map<string, number>()
    const guard = <T>(operation: keyof RecordingFileSystem, path: string, run: () => Promise<T>): Promise<T> => {
      const call = (calls.get(operation) ?? 0) + 1
      calls.set(operation, call)
      return fail(operation, path, call) ? Promise.reject(new Error(`injected ${operation} failure`)) : run()
    }
    return {
      mkdir: path => guard('mkdir', path, () => recordingFileSystem.mkdir(path)),
      readdir: path => guard('readdir', path, () => recordingFileSystem.readdir(path)),
      writeFile: (path, data) => guard('writeFile', path, () => recordingFileSystem.writeFile(path, data)),
      rename: (from, to) => guard('rename', from, () => recordingFileSystem.rename(from, to)),
      rm: path => guard('rm', path, () => recordingFileSystem.rm(path)),
      stat: path => guard('stat', path, () => recordingFileSystem.stat(path)),
    }
  }
  const NAME = 'sotto-activity-2026-10-20-14-32-05'

  it('leaves nothing behind when a file cannot be written', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    const fs = failing((operation, _path, call) => operation === 'writeFile' && call === 2)
    const error = await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { fs }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ActivityRecordingSaveError)
    expect((error as ActivityRecordingSaveError).left).toBeNull()
    expect(await readdir(directory)).toEqual([])
  })

  it('names the half-written folder when it cannot be removed either, and clears it at the next save', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    const fs = failing((operation, path, call) => (operation === 'writeFile' && call === 2) || (operation === 'rm' && path.endsWith('.partial')))
    const error = await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { fs }).catch((caught: unknown) => caught)
    expect((error as ActivityRecordingSaveError).left).toBe(`${NAME}.partial`)
    expect(await readdir(directory)).toEqual([`${NAME}.partial`])
    const saved = await saveActivityRecording(directory, NAME, { main: clean, window: null }, summary)
    expect(await readdir(directory)).toEqual([saved!.name])
  })

  it('keeps a recording whose folder was published even when tidying up afterwards fails', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    for (let minute = 10; minute < 16; minute += 1) await mkdir(join(directory, `sotto-activity-2026-10-20-13-${minute}-00`))
    let renamed = false
    const fs = failing(operation => {
      if (operation === 'rename') { renamed = true; return false }
      return renamed && (operation === 'rm' || operation === 'stat')
    })
    const saved = await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { fs })
    expect(saved).toMatchObject({ name: NAME, files: ['main.cpuprofile', 'window.cpuprofile', 'summary.json'] })
    expect(saved!.bytes).toBeGreaterThan(0)
    expect((await readdir(saved!.folder)).sort()).toEqual(['main.cpuprofile', 'summary.json', 'window.cpuprofile'])
    // Pruning could not remove the oldest two; the next save tries again.
    expect(await readdir(directory)).toHaveLength(7)
    await saveActivityRecording(directory, 'sotto-activity-2026-10-20-15-00-00', { main: clean, window: null }, summary)
    expect(await readdir(directory)).toHaveLength(5)
  })

  it('keeps nothing when the recording is thrown away while it is written, or as it is published', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    expect(await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { keep: () => false })).toBeNull()
    expect(await readdir(directory)).toEqual([])
    let asked = 0
    expect(await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { keep: () => (asked += 1) === 1 })).toBeNull()
    expect(asked).toBe(2)
    expect(await readdir(directory)).toEqual([])
  })

  it('marks a recording thrown away after it was published half-written when it cannot be removed, so the next start or save removes it', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    let asked = 0
    const fs = failing(operation => operation === 'rm')
    const error = await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { fs, keep: () => (asked += 1) === 1 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ActivityRecordingSaveError)
    expect((error as ActivityRecordingSaveError).left).toBe(`${NAME}.partial`)
    expect((error as ActivityRecordingSaveError).removedLater).toBe(true)
    expect(await readdir(directory)).toEqual([`${NAME}.partial`])
    expect(await sweepPartialActivityRecordings(directory)).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it('says a recording thrown away after it was published is kept when it can be neither marked nor removed', async () => {
    const directory = await scratch()
    const clean = cleanCpuProfile(rawProfile(), [APP])
    let asked = 0
    const fs = failing((operation, _path, call) => operation === 'rm' || (operation === 'rename' && call === 2))
    const error = await saveActivityRecording(directory, NAME, { main: clean, window: clean }, summary, { fs, keep: () => (asked += 1) === 1 }).catch((caught: unknown) => caught)
    expect((error as ActivityRecordingSaveError).left).toBe(NAME)
    expect((error as ActivityRecordingSaveError).removedLater).toBe(false)
    expect(await readdir(directory)).toEqual([NAME])
  })

  it('clears a stale half-written folder before saving', async () => {
    const directory = await scratch()
    await mkdir(join(directory, 'sotto-activity-2026-10-20-09-00-00.partial'))
    await writeFile(join(directory, 'sotto-activity-2026-10-20-09-00-00.partial', 'main.cpuprofile'), '{}')
    const saved = await saveActivityRecording(directory, NAME, { main: cleanCpuProfile(rawProfile(), [APP]), window: null }, summary)
    expect(await readdir(directory)).toEqual([saved!.name])
  })

  it('names a recording by when it started, in this computer\'s time', () => {
    expect(activityRecordingName(new Date(2026, 9, 20, 14, 32, 5))).toBe('sotto-activity-2026-10-20-14-32-05')
  })
})
