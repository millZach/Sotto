// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchConfiguration } from '../../../src/main/hosts/launchScript'
import { AskpassBroker } from '../../../src/main/hosts/sshAskpass'
import type { ValidatedSshHostConfiguration } from '../../../src/main/hosts/sshConfiguration'
import { SshHostLauncher } from '../../../src/main/hosts/sshLauncher'
import type { SpawnSsh } from '../../../src/main/hosts/sshProcess'

type SshProcess = ReturnType<SpawnSsh>

const HOST_ID = '11111111-1111-4111-8111-111111111111'
const HOST_PID = 4242
const REMOTE_PORT = 4317

const config: ValidatedSshHostConfiguration = {
  target: 'dev@forge',
  installPath: '~/.local/share/sotto-host',
  dataDirectory: '~/.local/share/sotto-host/data',
  remotePort: 0,
}

const bootOk = {
  supported: true,
  installed: true,
  enabled: true,
  active: true,
  linger: true,
  nodeDrift: false,
}

/** Splits a POSIX single-quoted command string the way fakeSsh.mjs does. */
function splitShellWords(text: string): string[] {
  const out: string[] = []
  let current: string | null = null
  for (let index = 0; index < text.length;) {
    const ch = text[index]
    if (ch === "'") {
      const end = text.indexOf("'", index + 1)
      current = (current ?? '') + text.slice(index + 1, end)
      index = end + 1
    } else if (ch === '\\') {
      current = (current ?? '') + text[index + 1]
      index += 2
    } else if (ch === ' ') {
      if (current !== null) out.push(current)
      current = null
      index++
    } else {
      current = (current ?? '') + ch
      index++
    }
  }
  if (current !== null) out.push(current)
  return out
}

function parseLaunchOp(args: readonly string[]): Record<string, unknown> | undefined {
  const withValue = new Set(['-o', '-i', '-p', '-L', '-e', '-l', '-F'])
  for (let i = 0; i < args.length; i++) {
    if (withValue.has(args[i]!)) { i++; continue }
    if (args[i]!.startsWith('-')) continue
    const command = args.slice(i + 1).join(' ')
    const words = splitShellWords(command)
    if (words[3] === 'sotto-launch' && words[4]) {
      return JSON.parse(words[4]) as Record<string, unknown>
    }
    return undefined
  }
  return undefined
}

function createFakeProcess(
  onStart: (proc: SshProcess, stdout: PassThrough, finish: (code: number) => void) => void,
  onKill?: () => void,
): SshProcess {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let closed = false
  let exitCode: number | null = null
  const finish = (code: number): void => {
    if (closed) return
    closed = true
    exitCode = code
    stdout.end()
    stderr.end()
    setImmediate(() => emitter.emit('close', code, null))
  }
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    get exitCode(): number | null { return exitCode },
    signalCode: null as NodeJS.Signals | null,
    kill: () => {
      onKill?.()
      finish(0)
      return true
    },
  }) as unknown as SshProcess
  queueMicrotask(() => onStart(proc, stdout, finish))
  return proc
}

describe('SshHostLauncher Rust host opt-in (ADR-0214)', () => {
  const servers: Server[] = []
  const launchers: SshHostLauncher[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const launcher of launchers.splice(0)) await launcher.disconnect()
    for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('omits useRustHost from launch configuration by default and includes it when explicitly requested', () => {
    const defaultLaunch = JSON.parse(launchConfiguration(config, { op: 'launch' }, 30_000)) as Record<string, unknown>
    expect(defaultLaunch.useRustHost).toBeUndefined()

    const rustLaunch = JSON.parse(launchConfiguration(config, { op: 'launch', useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustLaunch.useRustHost).toBe(true)

    const rustBootInstall = JSON.parse(launchConfiguration(config, { op: 'boot-install', hostId: 'h1', useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustBootInstall.useRustHost).toBe(true)

    const rustBootRemove = JSON.parse(launchConfiguration(config, { op: 'boot-remove', restart: true, useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustBootRemove.useRustHost).toBe(true)

    const rustInstall = JSON.parse(launchConfiguration(config, { op: 'update-install', version: '1.2.4', file: 'Sotto-host-1.2.4-linux-x64.tar.gz', sha256: 'a'.repeat(64), useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustInstall.useRustHost).toBe(true)

    const rustRestart = JSON.parse(launchConfiguration(config, { op: 'update-restart', hostId: 'h1', version: '1.2.4', useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustRestart.useRustHost).toBe(true)
  })

  it.each([
    { label: 'omits useRustHost by default', useRustHost: undefined, expected: undefined },
    { label: 'forwards useRustHost: true when enabled', useRustHost: true, expected: true },
    // A saved host set back to Node names Node, so the launch script clears the host's use-rust-host marker.
    { label: 'forwards useRustHost: false for a host set to Node', useRustHost: false, expected: false },
  ])('$label across launch, boot-install, boot-remove, update-install, and update-restart', async ({ useRustHost, expected }) => {
    vi.spyOn(AskpassBroker, 'start').mockResolvedValue({
      environment: () => ({}),
      forget: () => undefined,
      close: async () => undefined,
    } as unknown as AskpassBroker)

    const recordedOps: Record<string, unknown>[] = []
    const spawner: SpawnSsh = (_file, args) => {
      if (args.includes('-V')) {
        return createFakeProcess((_proc, _stdout, finish) => finish(0))
      }
      if (args.includes('-G')) {
        return createFakeProcess((_proc, stdout, finish) => {
          stdout.write('hostname forge.example.net\nuser dev\nport 22\n')
          finish(0)
        })
      }
      if (args.includes('-N')) {
        const forwardIndex = args.indexOf('-L')
        const forwardSpec = forwardIndex >= 0 ? args[forwardIndex + 1] ?? '' : ''
        const localPort = Number(forwardSpec.split(':')[1])
        const server = createServer((req, res) => {
          if (req.url === '/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ v: 1, status: 'ready', hostId: HOST_ID, pid: HOST_PID, port: REMOTE_PORT }))
            return
          }
          res.writeHead(404).end()
        })
        servers.push(server)
        return createFakeProcess(
          () => { server.listen(localPort, '127.0.0.1') },
          () => { server.close() },
        )
      }

      const op = parseLaunchOp(args)
      if (op) recordedOps.push(op)
      return createFakeProcess((_proc, stdout, finish) => {
        if (op?.op === 'launch') {
          stdout.write(`${JSON.stringify({ type: 'ready', v: 1, status: 'ready', hostId: HOST_ID, pid: HOST_PID, port: REMOTE_PORT, owned: true, runtime: useRustHost ? 'rust' : 'node' })}\n`)
        } else if (op?.op === 'boot-install') {
          stdout.write(`${JSON.stringify({ type: 'boot-installed', installed: true, stopped: false, bootStart: bootOk })}\n`)
        } else if (op?.op === 'boot-remove') {
          stdout.write(`${JSON.stringify({ type: 'boot-removed', stopped: false, bootStart: { ...bootOk, installed: false, enabled: false, active: false } })}\n`)
        } else if (op?.op === 'update-install') {
          stdout.write(`${JSON.stringify({ type: 'update-installed', version: '1.2.4' })}\n`)
        } else if (op?.op === 'update-restart') {
          stdout.write(`${JSON.stringify({ type: 'ready', v: 1, status: 'ready', hostId: HOST_ID, pid: HOST_PID, port: REMOTE_PORT, owned: true })}\n`)
        }
        finish(0)
      })
    }

    const launcher = new SshHostLauncher({
      spawn: spawner,
      ...(useRustHost !== undefined ? { useRustHost } : {}),
    })
    launchers.push(launcher)

    const connection = await launcher.connect(config)
    // The launch says which program the host runs, for the row's host program control.
    expect(connection.runtime).toBe(useRustHost ? 'rust' : 'node')
    await connection.boot({ op: 'boot-install' })
    await connection.boot({ op: 'boot-remove', restart: true })
    await connection.updateHost({ op: 'update-install', version: '1.2.4', file: 'Sotto-host-1.2.4-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
    await connection.updateHost({ op: 'update-restart', version: '1.2.4' })
    await connection.close()

    expect(recordedOps.map(op => op.op)).toEqual(['launch', 'boot-install', 'boot-remove', 'update-install', 'update-restart'])
    for (const op of recordedOps) {
      expect(op.useRustHost).toBe(expected)
    }
  })
})
