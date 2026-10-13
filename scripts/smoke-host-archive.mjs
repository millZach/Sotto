import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { Buffer } from 'node:buffer'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'
import { verifyHostArchive } from './verify-host-archive.mjs'

const PROVIDERS = ['codex', 'claude', 'grok', 'devin']

/** Read the app's one feature list, including later graduation, rather than keep a second switch in packaging. */
export async function hostArchiveUsageExpected(version, featureSource) {
  const source = stripTypeScriptTypes(featureSource ?? await readFile(resolve(import.meta.dirname, '../src/shared/owlFeatures.ts'), 'utf8'))
  const { isOwlFeatureEnabled } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const track = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u.test(version) ? 'owl' : 'stable'
  return isOwlFeatureEnabled('usage', track)
}

export async function smokeHostArchive(directory, { expectedVersion, expectedSourceCommit, expectedUsage } = {}) {
  const { manifest } = await verifyHostArchive(directory, { expectedVersion, expectedSourceCommit })
  const usageEnabled = expectedUsage ?? await hostArchiveUsageExpected(manifest.sottoVersion)
  const data = await mkdtemp(join(tmpdir(), 'sotto-host-smoke-'))
  // A host connects every provider installed and signed in on its machine (ADR-0036). The smoke runs on the release
  // machines and in CI, beside real clients and accounts, so every provider starts turned off and none is started.
  await writeFile(join(data, 'agents.json'), JSON.stringify({
    configuration: { disconnectedProviders: PROVIDERS }, assignments: [], queue: [], activeThreadId: null, activeProjectId: null,
    draft: '', draftThreadId: null, composing: false, outbox: [],
  }))
  // Windows cannot deliver SIGTERM. Only the Windows smoke substitutes the signal through IPC.
  const shim = "process.on('message',m=>{if(m==='SIGTERM'){process.emit('SIGTERM');process.disconnect()}})"
  const args = process.platform === 'win32' ? ['--import', 'data:text/javascript,' + encodeURIComponent(shim)] : []
  const child = spawn(process.execPath, [...args, join(resolve(directory), 'host/index.js'), '--data', data], {
    cwd: data, env: { ...process.env, NODE_PATH: '', SOTTO_HOST_DATA: '', SOTTO_HOST_KEY_FILE: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let deadline
  const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Packaged host did not start and stop within 30 seconds')), 30000) })
  let output = '', readyResolve, readyReject
  const ready = new Promise((resolveReady, reject) => { readyResolve = resolveReady; readyReject = reject })
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { readyReject(new Error('Packaged host exited before readiness')); resolveExit({ code, signal }) })
  })
  child.stderr.on('data', () => {}) // Diagnostics remain private; never print provider output.
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (output.length > 8192) { readyReject(new Error('Unexpected packaged host output')); return }
    for (const line of output.split('\n')) {
      try { const value = JSON.parse(line); if (value.v === 1 && value.event === 'ready') readyResolve(value) } catch { /* incomplete line */ }
    }
  })
  try {
    await Promise.race([timeout, (async () => {
      const descriptor = await ready
      const response = await globalThis.fetch('http://127.0.0.1:' + descriptor.port + '/v1/health', { signal: globalThis.AbortSignal.timeout(5000) })
      const health = await response.json()
      if (!response.ok || health.hostId !== descriptor.hostId || health.pid !== child.pid || health.status !== 'ready' ||
        descriptor.sottoVersion !== manifest.sottoVersion || health.sottoVersion !== manifest.sottoVersion) throw new Error('Packaged host health identity or version did not match')
      if (!Array.isArray(health.features) || !Array.isArray(descriptor.features) ||
        health.features.includes('usage-dashboard') !== usageEnabled || descriptor.features.includes('usage-dashboard') !== usageEnabled) throw new Error('Packaged host Usage capability did not match its own release')
      if (process.platform === 'win32') child.send('SIGTERM')
      else child.kill('SIGTERM')
      const result = await exited
      if (result.code !== 0 || result.signal !== null) throw new Error('Packaged host did not shut down cleanly')
      const identity = JSON.parse(await readFile(join(data, 'host.json'), 'utf8'))
      const workspace = JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8'))
      if (identity.hostId !== descriptor.hostId || workspace.snapshot.hostId !== identity.hostId) throw new Error('Packaged host did not preserve its identity and workspace')
      const agents = JSON.parse(await readFile(join(data, 'agents.json'), 'utf8'))
      if (agents.configuration?.disconnectedProviders?.join() !== PROVIDERS.join()) throw new Error('Packaged host did not keep its providers turned off')
    })()])
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.catch(() => {})
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass the extracted host archive directory')
  await smokeHostArchive(process.argv[2])
  process.stdout.write('Packaged host started, answered loopback health, and preserved its workspace on shutdown.\n')
}
