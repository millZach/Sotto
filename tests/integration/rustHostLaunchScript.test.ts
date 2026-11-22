// @vitest-environment node
// Phase 3.5 verification: runs Sotto's real `LAUNCH_SCRIPT_SOURCE` (`src/main/hosts/launchScript.ts`)
// against the compiled Rust `sotto-host` binary to verify opt-in launch (`useRustHost: true`),
// `/v1/health` discovery, `startedBy: "launch-script"` ownership, `stop-host`, and strict default
// preservation when `useRustHost` is omitted.
import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LAUNCH_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'

async function findRustHostBinary(): Promise<string> {
  const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', exe), join(cargoTargetDir, 'release', exe)] : []),
    resolve('target', 'debug', exe),
    resolve('target', 'release', exe),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next build location.
    }
  }
  throw new Error(`Could not find compiled Rust ${exe}. Run cargo build -p sotto-host --bin sotto-host first.`)
}

function runLaunchScript(cfg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify(cfg)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', code => {
      if (code !== 0) {
        rejectRun(new Error(`Launch script exited with ${code}: ${stderr || stdout}`))
        return
      }
      const events = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
      resolveRun(events)
    })
    child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  })
}

describe.skipIf(!RUN_RUST_HOST)('Rust sotto-host opt-in launch script integration (Phase 3.5)', () => {
  it('starts and stops the Rust sotto-host binary when useRustHost is true, and ignores it by default', async () => {
    const binary = await findRustHostBinary()
    const root = await mkdtemp(join(tmpdir(), 'sotto-rust-launch-'))
    const installPath = join(root, 'install')
    const dataDirectory = join(root, 'data')
    const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
    await mkdir(join(installPath, 'host'), { recursive: true })
    await mkdir(dataDirectory, { recursive: true })
    await copyFile(binary, join(installPath, 'host', exe))

    const baseCfg = {
      installPath,
      dataDirectory,
      remotePort: 0,
      nodeRange: '>=24.0.0 <25',
      readyTimeoutMs: 15_000,
      stopDrainMs: 5_000,
      archiveLimitBytes: 100_000_000,
      downloadTimeoutMs: 10_000,
      updateLockUnnamedMs: 5_000,
    }

    let hostId: string | undefined
    try {
      // Without `useRustHost: true`, the launch script must NOT spawn the Rust binary
      // and must report `archive-missing` since `host/index.js` is absent.
      const defaultEvents = await runLaunchScript({ ...baseCfg, op: 'launch' })
      expect(defaultEvents.at(-1)).toMatchObject({ type: 'error', reason: 'archive-missing' })

      // With `useRustHost: true`, the launch script spawns `host/sotto-host[.exe]` directly.
      const launchEvents = await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })
      const ready = launchEvents.find(ev => ev.type === 'ready')
      expect(ready).toBeDefined()
      expect(ready?.owned).toBe(true)
      expect(ready?.startedBy).toBe('launch-script')
      expect(typeof ready?.hostId).toBe('string')
      expect(typeof ready?.port).toBe('number')
      expect(typeof ready?.adminToken).toBe('string')
      hostId = String(ready!.hostId)

      // Confirm `/v1/health` responds directly from the running Rust host.
      const healthRes = await fetch(`http://127.0.0.1:${String(ready!.port)}/v1/health`)
      expect(healthRes.status).toBe(200)
      const health = (await healthRes.json()) as Record<string, unknown>
      expect(health.hostId).toBe(hostId)
      expect(health.status).toBe('ready')

      // Stop host via the same launch script (`stop-host`).
      const stopEvents = await runLaunchScript({ ...baseCfg, op: 'stop-host', hostId })
      expect(stopEvents.at(-1)).toMatchObject({ type: 'host-stopped', stopped: true, hostId })
      hostId = undefined
    } finally {
      if (hostId) {
        await runLaunchScript({ ...baseCfg, op: 'stop-host', hostId }).catch(() => undefined)
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)
})
