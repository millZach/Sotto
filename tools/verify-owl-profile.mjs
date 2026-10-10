// Run Owl's real save/load paths, then a clean stable checkout's load/save paths on a synthetic profile.
// node tools/verify-owl-profile.mjs <stable-checkout>
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { build } from 'vite'

const owlRoot = resolve(import.meta.dirname, '..')
const stableRoot = resolve(process.argv[2] ?? '')
if (!process.argv[2] || stableRoot === owlRoot) throw new Error('Supply the clean detached stable checkout.')
const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-profile-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-profile-')) throw new Error('Unexpected probe directory.')
const profile = join(temporary, 'profile')

function entrySource(seed) {
  return `
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { workspaceFixture } from '../tests/fixtures/workspaceFixture'
import { createAgentControl } from '../tests/fixtures/agentControlFixture'
import { testCredentials } from '../tests/fixtures/testCredentials'
import { SettingsRepository } from '../src/main/storage/settingsRepository'
${seed ? "import { commandCenterRecordFixture, centerHostId } from '../tests/fixtures/commandCenter'" : ''}
const profile = process.argv[2]
const settings = new SettingsRepository(join(profile, 'settings.json'))
const credentials = await testCredentials(profile, { mode: 'xor' })
${seed ? `
const initial = await workspaceFixture(profile)
await initial.host.connect()
const project = initial.host.workspaceSnapshot().projects[0]
const model = initial.host.workspaceSnapshot().models[0]
for (const id of ['ordinary', 'center', 'retired', 'worker']) await initial.host.execute({ type: 'create-thread', commandId: 'create-' + id,
  threadId: id, projectId: project.id, modelId: model.id, title: id })
const first = createAgentControl({ directory: profile, host: initial.host, credentials, historyEnabled: () => true })
await first.start(); await first.privacyChanged(); first.dispose(); await first.privacyChanged(); await initial.stop()
const workspace = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8'))
for (const thread of workspace.snapshot.threads) {
  thread.kind = thread.id === 'center' ? 'command-center' : thread.id === 'retired' ? 'command-center-history' : 'project'
  if (['ordinary', 'center', 'retired', 'worker'].includes(thread.id)) thread.messages = [{ id: 'message-' + thread.id,
    role: 'user', text: 'Synthetic history for ' + thread.id, createdAt: '2026-10-09T10:00:00.000Z' }]
}
await writeFile(join(profile, 'workspace.json'), JSON.stringify(workspace))
const agents = JSON.parse(await readFile(join(profile, 'agents.json'), 'utf8'))
agents.commandCenter = JSON.parse(JSON.stringify(commandCenterRecordFixture()).replaceAll(centerHostId, workspace.snapshot.hostId))
agents.commandCenter.current.projectId = project.id
agents.activeThreadId = 'ordinary'; agents.activeProjectId = project.id
agents.draft = 'Synthetic retained draft'; agents.draftThreadId = 'ordinary'
await writeFile(join(profile, 'agents.json'), JSON.stringify(agents))
await settings.update({ hotkey: 'Control+Alt+O', language: 'fr', commandCenterInFlightLimit: 6, llmQuality: 'high' })
await credentials.set('formatting', 'synthetic-profile-key')
` : ''}
const f = await workspaceFixture(profile)
const control = createAgentControl({ directory: profile, host: f.host, credentials, historyEnabled: () => true })
await control.start()
const loaded = { draft: control.get().draft, activeThreadId: control.get().activeThreadId,
  threads: f.host.workspaceSnapshot().threads.map(t => ({ id: t.id, kind: t.kind ?? null, title: t.title })) }
await control.privacyChanged(); control.dispose(); await control.privacyChanged(); await f.stop()
const currentSettings = await settings.get(); await settings.save(currentSettings)
const persistedAgents = JSON.parse(await readFile(join(profile, 'agents.json'), 'utf8'))
const persistedWorkspace = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8'))
const db = new DatabaseSync(join(profile, 'threads.sqlite'))
const messages = db.prepare('SELECT thread_id, count(*) AS count FROM messages GROUP BY thread_id ORDER BY thread_id').all()
db.close()
const report = { loaded, persisted: { commandCenter: persistedAgents.commandCenter ?? null,
  threads: persistedWorkspace.snapshot.threads.map(t => ({ id: t.id, kind: t.kind ?? null, title: t.title })) }, messages,
  settings: { hotkey: currentSettings.hotkey, language: currentSettings.language, commandCenterInFlightLimit: currentSettings.commandCenterInFlightLimit ?? null, llmQuality: currentSettings.llmQuality ?? null },
  credentialRetained: credentials.get('formatting') === 'synthetic-profile-key', corruptBackups: (await readdir(profile)).filter(n => n.includes('.corrupt-')) }
process.stdout.write(JSON.stringify(report))
`
}

async function run(sourceRoot, seed, name) {
  const entry = join(sourceRoot, 'scripts', `.owl-profile-${randomUUID()}.ts`)
  const output = join(temporary, name)
  try {
    await writeFile(entry, entrySource(seed))
    await build({ root: sourceRoot, configFile: false, logLevel: 'error', ssr: { noExternal: true }, build: {
      ssr: entry, target: 'node24', outDir: output, minify: false,
      rollupOptions: { external: ['node-pty'], output: { entryFileNames: 'probe.mjs', format: 'es' } },
    } })
    return JSON.parse(execFileSync(process.execPath, [join(output, 'probe.mjs'), profile], { encoding: 'utf8', timeout: 120_000 }))
  } finally { await rm(entry, { force: true }) }
}

try {
  const owl = await run(owlRoot, true, 'owl')
  const stable = await run(stableRoot, false, 'stable')
  const result = { stableCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: stableRoot, encoding: 'utf8' }).trim(), owl, stable }
  // Synthetic evidence only, under an already ignored output folder.
  await mkdir(join(owlRoot, 'release'), { recursive: true })
  await writeFile(join(owlRoot, 'release/owl-profile-compatibility.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally { await rm(temporary, { recursive: true, force: true }) }
