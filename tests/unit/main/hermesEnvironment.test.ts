// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  const bin = join(root, 'hermes-venv', 'bin')
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
  // Found on the login shell's PATH, as any other provider's CLI is; its private venv is still kept off every child's PATH.
  const loginPath = [nodeBin, brewBin, localBin, userBin, bin].join(delimiter)
  expect(await findHermesExecutable(environment, { home: root, platform: 'darwin', loginShellPath: async () => loginPath })).toBe(await realpath(executable))
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

it('follows a hermes link on PATH to the real script, so its private Python is found beside it', async () => {
  // pipx, uv or a hand-made link on PATH.
  if (process.platform === 'win32') return
  root = await mkdtemp(join(tmpdir(), 'sotto-hermes-link-'))
  const bin = join(root, 'venv', 'bin'), links = join(root, 'links')
  await mkdir(bin, { recursive: true }); await mkdir(links)
  await writeFile(join(bin, 'hermes'), '#!/private/hermes/python\n', { mode: 0o755 })
  await symlink(join(bin, 'hermes'), join(links, 'hermes'))
  expect(await findHermesExecutable({ HOME: root, PATH: links }, { home: root, platform: 'darwin', loginShellPath: async () => links })).toBe(await realpath(join(bin, 'hermes')))
})

describe('the gateway', () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }) as unknown as ChildProcess
  const setup = async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-hermes-gateway-'))
    const executable = join(root, 'bin', 'hermes')
    const children: ChildProcess[] = []
    const spawnProcess = vi.mocked(spawn).mockImplementation((() => { const child = fakeChild(); children.push(child); return child }) as unknown as typeof spawn)
    // The readiness poll never answers, as when its gateway died before it was ready.
    const runFile = vi.mocked(execFile).mockImplementation(((() => new EventEmitter() as ChildProcess) as unknown) as typeof execFile)
    return { executable, children, spawnProcess, runFile, runtime: new HermesRuntime(root, () => {}, { HOME: root, PATH: '' }) }
  }

  it('spawns nothing for a start that began before a Disconnect', async () => {
    const { executable, spawnProcess, runtime } = await setup()
    const stops = runtime.stops
    runtime.stop()
    await expect(runtime.start(executable, stops)).rejects.toThrow(/disconnected/u)
    await expect(runtime.project(executable, root!, [], stops)).rejects.toThrow(/disconnected/u)
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('starts a fresh gateway once the one a poll was waiting for has closed, instead of awaiting the dead poll', async () => {
    const { executable, children, spawnProcess, runtime } = await setup()
    void runtime.start(executable).catch(() => undefined)
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    children[0]!.emit('close', 1)
    void runtime.start(executable).catch(() => undefined)
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))
    runtime.stop()
  })

  it('stops a gateway an earlier Sotto left in its folder before starting its own', async () => {
    const { executable, spawnProcess, runFile, runtime } = await setup()
    await writeFile(join(root!, 'gateway.pid'), '{"pid": 1}')
    runFile.mockImplementationOnce(((...args: unknown[]) => { (args.at(-1) as (error: null) => void)(null); return new EventEmitter() as ChildProcess }) as typeof execFile)
    void runtime.start(executable).catch(() => undefined)
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    expect(runFile).toHaveBeenNthCalledWith(1, executable, ['gateway', 'stop', '-y'], expect.objectContaining({ cwd: root }), expect.any(Function))
    runtime.stop()
  })
})
