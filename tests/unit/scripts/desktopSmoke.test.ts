// @vitest-environment node
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  process: { platform: 'win32', execPath: 'node', env: {} as Record<string, string>, exit: vi.fn() },
}))
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }))
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('node:process', () => ({ default: mocks.process }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.process.platform = 'win32'
  mocks.process.env = { npm_execpath: 'npm-cli.js' }
  mocks.existsSync.mockReturnValue(false)
  mocks.spawnSync.mockReturnValue({ status: 0 })
  mocks.process.exit.mockImplementation(() => { throw new Error('exited') })
})

describe('Windows desktop smoke command', () => {
  it('refuses other platforms before running a stage', async () => {
    mocks.process.platform = 'linux'
    await expect(import('../../../scripts/desktop-smoke.mjs')).rejects.toThrow('must run on Windows')
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })

  it('requires npm and an absent performance-data directory', async () => {
    delete mocks.process.env.npm_execpath
    await expect(import('../../../scripts/desktop-smoke.mjs')).rejects.toThrow('Start this check with npm')
    vi.resetModules()
    mocks.process.env.npm_execpath = 'npm-cli.js'
    mocks.existsSync.mockReturnValue(true)
    await expect(import('../../../scripts/desktop-smoke.mjs')).rejects.toThrow('performance data path to be absent')
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })

  it('uses this checkout and scripted journeys without live calls or timing flags', async () => {
    Object.assign(mocks.process.env, {
      SOTTO_CLAUDE_LIVE: '1', SOTTO_GROK_LIVE: '1', SOTTO_PERF_BENCH: '1', SOTTO_PERF_ASSERT: '1',
      SOTTO_PERF_DATA: 'personal-profile', SOTTO_E2E_MAIN_ENTRY: 'another-build', SOTTO_E2E_ARTIFACT_ROOT: 'published-evidence',
    })
    await import('../../../scripts/desktop-smoke.mjs')
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2)
    const [executable, recovery, options] = mocks.spawnSync.mock.calls[0]!
    expect(executable).toBe('node')
    expect(recovery).toEqual(['npm-cli.js', 'run', 'test:recovery'])
    expect(options.env.SOTTO_PERF_DATA).toBe(join(options.cwd, 'artifacts/review-393/absent-perf-data'))
    expect(options.env.SOTTO_E2E_ARTIFACT_ROOT).toBe(join(options.cwd, 'artifacts/review-393/desktop-run'))
    for (const key of ['SOTTO_CLAUDE_LIVE', 'SOTTO_GROK_LIVE', 'SOTTO_PERF_BENCH', 'SOTTO_PERF_ASSERT', 'SOTTO_E2E_MAIN_ENTRY']) {
      expect(options.env).not.toHaveProperty(key)
    }
    expect(mocks.spawnSync.mock.calls[1]![1]).toEqual([
      join(options.cwd, 'node_modules/@playwright/test/cli.js'), 'test',
      'tests/e2e/daily-workspace.spec.ts', 'tests/e2e/settings-index.spec.ts', 'tests/e2e/widget-dictation.spec.ts', '--workers=1',
    ])
    expect(mocks.spawnSync.mock.calls[1]![2]).toEqual(options)
  })

  describe.each([1, 2])('failure in stage %i', (stage) => {
    it.each([
      { name: 'nonzero exit', result: { status: 7 }, exitStatus: 7 },
      { name: 'Windows crash', result: { status: 3221225477 }, exitStatus: 3221225477 },
      { name: 'signal termination', result: { status: null, signal: 'SIGTERM' }, exitStatus: 1 },
    ])('stops after $name and preserves a failing exit status', async ({ result, exitStatus }) => {
      for (let previous = 1; previous < stage; previous++) mocks.spawnSync.mockReturnValueOnce({ status: 0 })
      mocks.spawnSync.mockReturnValueOnce(result)
      await expect(import('../../../scripts/desktop-smoke.mjs')).rejects.toThrow('exited')
      expect(mocks.process.exit).toHaveBeenCalledWith(exitStatus)
      expect(mocks.spawnSync).toHaveBeenCalledTimes(stage)
    })

    it.each([
      { name: 'launch error', error: Object.assign(new Error('Cannot start node'), { code: 'ENOENT' }) },
      { name: 'timeout', error: Object.assign(new Error('Child timed out'), { code: 'ETIMEDOUT' }) },
    ])('surfaces a $name without running another stage', async ({ error }) => {
      for (let previous = 1; previous < stage; previous++) mocks.spawnSync.mockReturnValueOnce({ status: 0 })
      mocks.spawnSync.mockReturnValueOnce({ status: null, error })
      await expect(import('../../../scripts/desktop-smoke.mjs')).rejects.toBe(error)
      expect(mocks.process.exit).not.toHaveBeenCalled()
      expect(mocks.spawnSync).toHaveBeenCalledTimes(stage)
    })
  })
})
