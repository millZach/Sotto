import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { watcherRecordSchema } from '../../src/shared/watcher'
import { SettingsRepository } from '../../src/main/storage/settingsRepository'
import { createAgentControl } from './agentControlFixture'
import { testCredentials } from './testCredentials'
import { watcherRecordFixture, centerHostId, centerTime } from './watcher'
import { workspaceFixture } from './workspaceFixture'
import { savedAgentsState, withoutWatcherFile } from './savedWatcher'

/** Real same-branch persistence with synthetic providers/credentials, never a personal profile. */
export async function owlProfileRoundTrip(profile: string) {
  const settings = new SettingsRepository(join(profile, 'settings.json'))
  const credentials = await testCredentials(profile, { mode: 'xor' })
  const initial = await workspaceFixture(profile, { watcherEnabled: true })
  await initial.host.connect()
  const project = initial.host.workspaceSnapshot().projects[0]!
  const model = initial.host.workspaceSnapshot().models[0]!
  for (const id of ['ordinary', 'center', 'retired', 'replacement', 'worker']) {
    await initial.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, modelId: model.id, title: id })
  }
  const first = createAgentControl({ directory: profile, host: initial.host, credentials, historyEnabled: () => true, watcherEnabled: true })
  await first.start(); await first.privacyChanged(); first.dispose(); await first.privacyChanged(); await initial.stop()
  const workspace = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8'))
  for (const thread of workspace.snapshot.threads) {
    thread.kind = thread.id === 'center' || thread.id === 'replacement' ? 'watcher' : thread.id === 'retired' ? 'watcher-history' : 'project'
    if (['ordinary', 'center', 'retired', 'replacement', 'worker'].includes(thread.id)) {
      thread.messages = [{ id: `message-${thread.id}`, role: 'user', text: `Synthetic history for ${thread.id}`, createdAt: centerTime }]
    }
  }
  await writeFile(join(profile, 'workspace.json'), JSON.stringify(workspace))
  const agents = JSON.parse(await readFile(join(profile, 'agents.json'), 'utf8'))
  agents.watcher = JSON.parse(JSON.stringify(watcherRecordFixture()).replaceAll(centerHostId, workspace.snapshot.hostId))
  const watcher = agents.watcher
  watcher.current.projectId = project.id
  watcher.history = [{ ...watcher.current, target: { ...watcher.current.target, threadId: 'retired' }, creationOperationId: '55555555-5555-4555-8555-555555555555' }]
  watcher.creation = { identity: { ...watcher.current, target: { ...watcher.current.target, threadId: 'replacement' }, creationOperationId: '66666666-6666-4666-8666-666666666666' },
    phase: 'intent', replaces: watcher.current.target }
  Object.assign(watcher.operations[0], { creationReceiptId: 'creation-receipt', firstPromptReceiptId: 'first-prompt-receipt', commandId: 'synthetic-command',
    draftId: '77777777-7777-4777-8777-777777777777', itemId: 'synthetic-item', anchorMessageId: 'synthetic-anchor', toolCallId: 'synthetic-call' })
  watcher.reads[0].lastWakeEventId = 'synthetic-wake'
  watcherRecordSchema.parse(watcher)
  agents.activeThreadId = 'ordinary'; agents.activeProjectId = project.id
  agents.draft = 'Synthetic retained ordinary draft'; agents.draftThreadId = 'ordinary'
  agents.threadDrafts.push({ threadId: 'center', draftId: '88888888-8888-4888-8888-888888888888', text: 'Synthetic parked Watcher draft',
    attachments: [], requestId: null, updatedAt: centerTime })
  agents.threadDrafts.push({ threadId: 'retired', draftId: '99999999-9999-4999-8999-999999999999', text: 'Synthetic parked Watcher history draft',
    attachments: [], requestId: null, updatedAt: centerTime })
  await writeFile(join(profile, 'agents.json'), JSON.stringify(agents))
  await withoutWatcherFile(profile)
  await settings.update({ hotkey: 'Control+Alt+O', autoPaste: false, historyEnabled: true })
  await credentials.set('formatting', 'synthetic-profile-key')

  async function loadAndSave(watcherEnabled: boolean) {
    const loadedCredentials = await testCredentials(profile, { mode: 'xor' })
    const loadedSettings = new SettingsRepository(join(profile, 'settings.json'))
    const fixture = await workspaceFixture(profile, { watcherEnabled })
    const control = createAgentControl({ directory: profile, host: fixture.host, credentials: loadedCredentials, historyEnabled: () => true, watcherEnabled })
    await control.start()
    const loaded = { draft: control.get().draft, activeThreadId: control.get().activeThreadId,
      threads: control.get().host.threads.map(thread => ({ id: thread.id, kind: thread.kind, title: thread.title })) }
    await control.privacyChanged(); control.dispose(); await control.privacyChanged(); await fixture.stop()
    const currentSettings = await loadedSettings.get(); await loadedSettings.save(currentSettings)
    const persistedAgents = await savedAgentsState(profile)
    const persistedWorkspace = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8'))
    const db = new DatabaseSync(join(profile, 'threads.sqlite'))
    const messages = db.prepare('SELECT thread_id, message_id, role, text, created_at FROM messages ORDER BY thread_id, message_id').all()
    db.close()
    return { loaded, watcher: persistedAgents.watcher, agents: persistedAgents, workspace: persistedWorkspace,
      threads: persistedWorkspace.snapshot.threads.map((thread: { id: string; kind: string; title: string }) => ({ id: thread.id, kind: thread.kind, title: thread.title })),
      bindings: JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8')),
      settings: currentSettings, messages, credentialRetained: loadedCredentials.get('formatting') === 'synthetic-profile-key',
      corruptBackups: (await readdir(profile)).filter(name => name.includes('.corrupt-')) }
  }
  const owl = await loadAndSave(true)
  const stable = await loadAndSave(false)
  const reopenedOwl = await loadAndSave(true)
  for (const stage of [owl, stable, reopenedOwl]) {
    assert.deepEqual(stage.watcher, watcher, 'Every Watcher record field must survive actual saves')
    assert.equal(stage.credentialRetained, true)
    assert.deepEqual(stage.corruptBackups, [])
  }
  for (const stage of [stable, reopenedOwl]) {
    assert.deepEqual(stage.threads, owl.threads, 'Ordinary and Watcher identities, titles and kinds survive')
    assert.deepEqual(stage.messages, owl.messages, 'Ordinary and Watcher history survives value for value')
    assert.deepEqual(stage.settings, owl.settings, 'All settings survive, including Watcher capacity')
    assert.deepEqual(stage.agents, owl.agents, 'All persisted coordinator data survives value for value')
    assert.deepEqual(stage.bindings, owl.bindings, 'Every real ThreadRegistry binding survives value for value')
    assert.deepEqual(stage.workspace, owl.workspace, 'The complete workspace survives value for value')
  }
  assert.equal(stable.loaded.threads.some(thread => thread.kind === 'watcher' || thread.kind === 'watcher-history'), false)
  assert.equal(reopenedOwl.loaded.threads.length, owl.loaded.threads.length)
  return { owl, stable, reopenedOwl, preserved: { watcher: true, agents: true, threadKindsAndTitles: true, settings: true, messages: true, credential: true } }
}
