// @vitest-environment node
import { expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

it('Claude native rollback retains the exact earlier turn and its Sotto identity across restart', async () => {
  let f = await claudeFixture(undefined, 1500)
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', path: f.root, title: 'Synthetic' })
    await f.host.execute({ type: 'create-thread', commandId: 't', projectId: 'p', threadId: 't', title: 'Synthetic', modelId: f.modelId })
    for (const id of ['first', 'second']) {
      await f.host.execute({ type: 'send', commandId: id, threadId: 't', messageId: id, text: id })
      await f.driver.completeTurn('t', `${id} answer`)
      await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('idle')
    }
    await f.action('t', { type: 'noop' })
    expect(f.adapter.rollbackCapability('missing').supported).toBe(false)
    await expect(f.adapter.rollbackThread('t', 1, ['first', 'wrong'])).rejects.toThrow('changed')
    expect(await f.adapter.rollbackThread('t', 1, ['first', 'second'])).toEqual({ accepted: true })
    const before = (await f.host.snapshot()).threads[0]!
    expect(before.messages.map(message => message.text)).toEqual(['first', 'first answer'])
    expect(before.messages[0]).toMatchObject({ id: 'first', commandId: 'first' })
    expect(before.historyEpoch).toBeTruthy()
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    expect(before.historyEpoch).not.toBe(aliases.t.sessionId)
    f.host.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root, 1500)
    await f.host.connect()
    const after = (await f.host.snapshot()).threads[0]!
    expect(after.messages).toEqual(before.messages); expect(after.historyEpoch).toBe(before.historyEpoch)
    expect(await f.host.execute({ type: 'send', commandId: 'third', threadId: 't', messageId: 'third', text: 'A different continuation' })).toEqual({ accepted: true })
    expect((await f.host.snapshot()).threads[0]!.messages.map(message => message.text)).not.toContain('second')
  } finally { await f.cleanup() }
}, 20000)

it('Claude reconciles a completed native fork after its final alias write fails without repeating the rollback', async () => {
  let f = await claudeFixture(undefined, 1500)
  const aliasPath = join(f.root, 'claude-threads.json'), savedPath = join(f.root, 'interrupted-alias.json')
  let blocked = false, blocking: Promise<void> | undefined
  let watcher: ReturnType<typeof watch> | undefined
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', path: f.root, title: 'Synthetic' })
    await f.host.execute({ type: 'create-thread', commandId: 't', projectId: 'p', threadId: 't', title: 'Synthetic', modelId: f.modelId })
    for (const id of ['first', 'second']) {
      await f.host.execute({ type: 'send', commandId: id, threadId: 't', messageId: id, text: id })
      await f.driver.completeTurn('t', `${id} answer`)
      await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('idle')
    }
    await f.action('t', { type: 'noop' })
    // A filesystem fault at the persistence boundary, while the real official
    // native helper continues. No mocked fork or private adapter invocation.
    watcher = watch(f.root, (_event, name) => {
      if (name !== 'claude-threads.json' || blocking) return
      blocking = (async () => {
        const disk = JSON.parse(await readFile(aliasPath, 'utf8'))
        if (!disk.t.rollbackPending?.targetSessionId) return
        watcher?.close(); await rename(aliasPath, savedPath); await mkdir(aliasPath); blocked = true
      })().finally(() => { if (!blocked) blocking = undefined })
    })
    expect(await f.adapter.rollbackThread('t', 1, ['first', 'second'])).toEqual({ accepted: false, uncertain: true })
    await blocking; expect(blocked).toBe(true)
    expect(f.adapter.rollbackCapability('t').supported).toBe(false)
    await expect(f.adapter.rollbackThread('t', 1, ['first', 'second'])).rejects.toThrow('unconfirmed')
    await rmdir(aliasPath); await rename(savedPath, aliasPath); blocked = false
    f.host.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root, 1500)
    await f.host.connect()
    const recovered = (await f.host.snapshot()).threads[0]!
    expect(recovered.messages.map(message => message.text)).toEqual(['first', 'first answer'])
    expect(recovered.messages[0]).toMatchObject({ id: 'first', commandId: 'first' })
    expect(f.adapter.rollbackCapability('t').supported).toBe(true)
  } finally {
    watcher?.close(); await blocking
    if (blocked) { await rmdir(aliasPath); await rename(savedPath, aliasPath) }
    await f.cleanup()
  }
}, 20000)
