// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { findHermesExecutable, HermesRpc, readHermesVersion } from '../../../src/main/agents/hermesRpc'
import { HermesRuntime } from '../../../src/main/agents/hermesRuntime'
import { resetCliLookup, withCliPath } from '../../../src/main/agents/cliLookup'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))

let root: string | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  resetCliLookup()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.each(['bare', 'full'])('keeps discovered tools and removes only the private venv from every Hermes process with a %s PATH', async mode => {
  root = await mkdtemp(join(tmpdir(), 'sotto-hermes-env-'))
  const bin = join(root, 'Developer', 'Tools', 'hermes-v0.23.0', '.venv', 'bin')
  const userBin = join(root, 'user-bin')
  const nodeBin = join(root, 'node-bin')
  const brewBin = join(root, 'homebrew-bin')
  const localBin = join(root, 'local-bin')
  await mkdir(bin, { recursive: true })
  await mkdir(userBin)
  await mkdir(nodeBin)
  const executable = join(bin, 'hermes')
  await writeFile(executable, '#!/private/hermes/python\n', { mode: 0o755 })
  await writeFile(join(nodeBin, 'node'), '#!/user/node\n', { mode: 0o755 })
  const environment = { HOME: root, PATH: mode === 'bare' ? userBin : [userBin, nodeBin].join(delimiter) }
  const loginPath = [nodeBin, brewBin, localBin, userBin].join(delimiter)
  expect(await findHermesExecutable(environment, { home: root, platform: 'darwin', loginShellPath: async () => loginPath })).toBe(executable)
  const sharedPath = withCliPath(environment, executable).PATH!.split(delimiter)
  expect(sharedPath[0]).toBe(bin)
  expect(sharedPath).toEqual(mode === 'bare' ? [bin, nodeBin, userBin, brewBin, localBin] : [bin, userBin, nodeBin, brewBin, localBin])

  const children: ChildProcessWithoutNullStreams[] = []
  const spawnProcess = vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    }) as unknown as ChildProcessWithoutNullStreams
    children.push(child)
    return child
  })
  const runFile = vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void
    callback(null, 'Hermes Agent v0.23.0', '')
    return new EventEmitter() as ChildProcess
  }) as typeof execFile)
  const runtime = new HermesRuntime(root, () => {}, environment)
  const env = runtime.env()
  const launchEnv = { ...env, PATH: sharedPath.filter(folder => folder !== bin).join(delimiter) }
  expect(await readHermesVersion(executable, env)).toBe('0.23.0')
  const rpc = new HermesRpc(executable, ['acp'], root, env, 1000, () => {}, () => {})
  await runtime.project(executable, root, [])

  expect(spawnProcess).toHaveBeenCalledTimes(2)
  expect(spawnProcess).toHaveBeenNthCalledWith(1, executable, ['acp'], expect.objectContaining({ env: launchEnv }))
  expect(spawnProcess).toHaveBeenNthCalledWith(2, executable, ['gateway', 'run', '--quiet', '--no-supervise', '--external-supervisor'], expect.objectContaining({ env: launchEnv }))
  expect(runFile).toHaveBeenCalledTimes(3)
  expect(runFile).toHaveBeenNthCalledWith(1, executable, ['--version'], expect.objectContaining({ env: launchEnv }), expect.any(Function))
  for (const call of runFile.mock.calls.slice(1)) {
    expect(call[0]).toBe(join(bin, 'python'))
    expect(call[2]).toEqual(expect.objectContaining({ env: launchEnv }))
  }
  expect(env.PATH).toBe(environment.PATH)
  expect(withCliPath(environment, executable).PATH?.split(delimiter)).toEqual(sharedPath)
  rpc.close()
  runtime.stop()
  for (const child of children) child.emit('close', 0)
  await Promise.all([rpc.closed, runtime.closed()])
})
