// Sets the scene every take starts from: the stage, pantry, and four threads with their first exchanges.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStage, paths, stageEnvironment } from './lib/stage.mjs'
import { makeProject } from './demo/project.mjs'
import { launch, sleep, until } from './lib/rig.mjs'
import { saveSeed } from './lib/snapshot.mjs'
import { exchanges } from './scenes/exchanges.mjs'

export const PROFILE_SETTINGS = {
  onboardingComplete: true, autoUpdateCheck: false, appearance: 'dark', lightTheme: 'sotto', darkTheme: 'sotto',
  voiceCoordinatorEnabled: false, memoryEnabled: false, historyEnabled: true, threadTitles: true, commitMessages: true, pullRequestText: true,
  soundCues: false, showWidgetWhenIdle: true, gitFetchIntervalSeconds: 30,
}

export async function prepare() {
  buildStage()
  const env = stageEnvironment()
  makeProject({ project: paths.project, remote: join(paths.root, 'remotes', 'pantry.git'), env })
  console.log('Installing pantry’s own dependencies')
  execFileSync(process.execPath, [join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: paths.project, env, stdio: 'inherit' })
  const locked = '2026-09-22T16:40:00-07:00'
  execFileSync('git', ['add', 'package-lock.json'], { cwd: paths.project, env })
  execFileSync('git', ['commit', '-q', '-m', 'Lock dependency versions'], { cwd: paths.project, env: { ...env, GIT_AUTHOR_DATE: locked, GIT_COMMITTER_DATE: locked } })
  execFileSync('git', ['push', '-q'], { cwd: paths.project, env })
  rmSync(paths.profile, { recursive: true, force: true }); mkdirSync(paths.profile, { recursive: true })
  writeFileSync(join(paths.profile, 'settings.json'), JSON.stringify(PROFILE_SETTINGS))
  writeFileSync(join(paths.fakes, 'gh-state.json'), JSON.stringify({ pulls: [], calls: [] }))

  const rig = await launch()
  try {
    await rig.command({ type: 'configure', patch: { enabled: true, speak: false, checkClientUpdates: false } })
    for (const provider of ['claude', 'codex', 'grok', 'devin']) await rig.command({ type: 'connect', provider })
    await until(async () => (await rig.state()).host.providers?.every(p => p.connection === 'connected'), { what: 'all four providers', timeout: 60_000 })
    await rig.command({ type: 'create-project', title: 'pantry', path: paths.project, useExisting: true })
    const state = await rig.state()
    const project = state.host.projects.find(p => p.title === 'pantry')
    const model = provider => state.host.models.find(m => m.providerId === provider && m.ready !== false)?.id
    const threads = {}
    for (const scene of exchanges) {
      const threadId = randomUUID()
      await rig.command({ type: 'create-thread', threadId, projectId: project.id, title: 'New thread', titleSource: 'default', modelId: model(scene.provider),
        workingCopy: scene.worktree ? 'independent' : 'shared', managed: false, ...(scene.runtimeMode ? { runtimeMode: scene.runtimeMode } : {}), ...(scene.effort ? { reasoningEffort: scene.effort } : {}) })
      // The window names threads by host as well: host:<host ID>:<thread ID>.
      threads[scene.key] = await until(async () => (await rig.state()).host.threads.find(t => t.id.endsWith(threadId))?.id, { what: 'the new thread' })
    }
    writeFileSync(join(paths.root, 'threads.json'), JSON.stringify(threads, null, 2))
    for (const scene of exchanges) if (scene.prepare) { console.log(`Exchange: ${scene.key}`); await scene.prepare(rig, threads[scene.key]) }
    await sleep(1500)
  } catch (error) {
    writeFileSync(join(paths.root, 'tmp', 'failed-state.json'), JSON.stringify(await rig.state().catch(() => null), null, 2))
    await rig.main.screenshot({ path: join(paths.root, 'tmp', 'failed.png') }).catch(() => undefined)
    throw error
  } finally { await rig.close() }
  saveSeed()
  console.log('Seed saved')
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare()
