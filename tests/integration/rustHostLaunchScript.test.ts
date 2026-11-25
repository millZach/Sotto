// @vitest-environment node
// Phase 3.5 verification: runs Sotto's real `LAUNCH_SCRIPT_SOURCE` (`src/main/hosts/launchScript.ts`)
// against the compiled Rust `sotto-host` binary to verify opt-in launch (`useRustHost: true`),
// `/v1/health` discovery, `startedBy: "launch-script"` ownership, `stop-host`, and strict default
// preservation when `useRustHost` is omitted.
import { spawn } from 'node:child_process'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  // The row's Node | Rust control (ADR-0214): a launch naming the other program restarts a detached host Sotto started on
  // the one named, and Node clears the marker. Windows cannot say which program a process is, so it only syncs the marker.
  it('switches a detached host Sotto started between Rust and Node when a launch names the other program', async () => {
    const binary = await findRustHostBinary()
    const root = await mkdtemp(join(tmpdir(), 'sotto-rust-launch-switch-'))
    const installPath = join(root, 'install')
    const dataDirectory = join(root, 'data')
    const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
    await mkdir(join(installPath, 'host'), { recursive: true })
    await mkdir(dataDirectory, { recursive: true })
    await copyFile(binary, join(installPath, 'host', exe))
    await writeFile(join(installPath, 'package.json'), JSON.stringify({ type: 'module' }))
    await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host', 'index.js'))
    const marker = join(installPath, 'use-rust-host')
    const baseCfg = {
      installPath, dataDirectory, remotePort: 0, nodeRange: '>=24.0.0 <25', readyTimeoutMs: 15_000, stopDrainMs: 5_000,
      archiveLimitBytes: 100_000_000, downloadTimeoutMs: 10_000, updateLockUnnamedMs: 5_000,
    }
    const switches = process.platform !== 'win32'
    let running: Record<string, unknown> | undefined
    try {
      running = (await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })).find(ev => ev.type === 'ready')
      expect(running).toMatchObject({ owned: true })
      expect(await readFile(marker, 'utf8')).toBe('1\n')
      if (switches) expect(running?.runtime).toBe('rust')
      const rustPid = running?.pid

      running = (await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: false })).find(ev => ev.type === 'ready')
      expect(running).toMatchObject({ owned: true })
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      if (switches) {
        expect(running?.runtime).toBe('node')
        expect(running?.pid).not.toBe(rustPid)
        expect(running?.hostId).toBe('11111111-1111-4111-8111-111111111111')
      }

      // A launch that names no program, as stable's, leaves the running host as it is.
      const kept = (await runLaunchScript({ ...baseCfg, op: 'launch' })).find(ev => ev.type === 'ready')
      expect(kept?.pid).toBe(running?.pid)
    } finally {
      if (typeof running?.hostId === 'string') await runLaunchScript({ ...baseCfg, op: 'stop-host', hostId: running.hostId }).catch(() => undefined)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 60_000)

  it('falls back cleanly to Node host when sotto-host is non-executable, wrong-arch, or fails startup on unreadable agents.json (N5)', async () => {
    const binary = await findRustHostBinary()
    const root = await mkdtemp(join(tmpdir(), 'sotto-rust-launch-n5-'))
    const installPath = join(root, 'install')
    const dataDirectory = join(root, 'data')
    const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
    const rustBinPath = join(installPath, 'host', exe)
    await mkdir(join(installPath, 'host'), { recursive: true })
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(join(installPath, 'package.json'), JSON.stringify({ type: 'module' }))
    await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host', 'index.js'))

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

    const stopIfRunning = async (id: string | undefined): Promise<void> => {
      if (id) await runLaunchScript({ ...baseCfg, op: 'stop-host', hostId: id }).catch(() => undefined)
    }

    try {
      // 1. Wrong-arch / invalid binary falls back cleanly to Node `host/index.js`.
      const wrongElf = Buffer.alloc(24)
      wrongElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0)
      // Write the opposite architecture machine ID (arm64 on x64, x64 on arm64).
      wrongElf.writeUInt16LE(process.arch === 'x64' ? 0xb7 : 0x3e, 18)
      await writeFile(rustBinPath, wrongElf)
      if (process.platform !== 'win32') await chmod(rustBinPath, 0o755)
      const wrongArchEvents = await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })
      const wrongArchReady = wrongArchEvents.find(ev => ev.type === 'ready')
      expect(wrongArchReady).toBeDefined()
      expect(wrongArchReady?.hostId).toBe('11111111-1111-4111-8111-111111111111')
      await stopIfRunning(String(wrongArchReady!.hostId))

      // 2. Non-executable `host/sotto-host` falls back cleanly to Node `host/index.js` on POSIX.
      if (process.platform !== 'win32') {
        await copyFile(binary, rustBinPath)
        await chmod(rustBinPath, 0o644)
        const nonExecEvents = await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })
        const nonExecReady = nonExecEvents.find(ev => ev.type === 'ready')
        expect(nonExecReady).toBeDefined()
        expect(nonExecReady?.hostId).toBe('11111111-1111-4111-8111-111111111111')
        await stopIfRunning(String(nonExecReady!.hostId))
      }

      // 3. Valid `sotto-host` binary that fails startup (corrupt `agents.json`) falls back cleanly to Node `host/index.js`.
      await copyFile(binary, rustBinPath)
      if (process.platform !== 'win32') await chmod(rustBinPath, 0o755)
      await writeFile(join(dataDirectory, 'agents.json'), '{not-valid-json', 'utf8')
      const fallbackEvents = await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })
      const fallbackReady = fallbackEvents.find(ev => ev.type === 'ready')
      expect(fallbackReady).toBeDefined()
      expect(fallbackReady?.hostId).toBe('11111111-1111-4111-8111-111111111111')
      await stopIfRunning(String(fallbackReady!.hostId))

      // 4. Without Node fallback, a non-runnable `sotto-host` reports `host-start-failed` (not `archive-missing`).
      await rm(join(installPath, 'host', 'index.js'))
      await writeFile(rustBinPath, wrongElf)
      if (process.platform !== 'win32') await chmod(rustBinPath, 0o755)
      const noFallbackEvents = await runLaunchScript({ ...baseCfg, op: 'launch', useRustHost: true })
      expect(noFallbackEvents.at(-1)).toMatchObject({ type: 'error', reason: 'host-start-failed' })
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)
})
