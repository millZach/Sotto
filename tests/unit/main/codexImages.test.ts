// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AGENT_MAX_IMAGE_BYTES, attachmentSizeBytes, type AgentAttachment } from '../../../src/shared/agents'
import { codexFixture } from '../../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const image: AgentAttachment = { id: 'shot', name: 'Screenshot.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=' }
const reference = (attachment: AgentAttachment) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachmentSizeBytes(attachment.dataUrl) })
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture(models?: unknown[], requestTimeoutMs = 2000) {
  const f = await codexFixture(undefined, false, requestTimeoutMs); fixtures.push(f)
  if (models) await f.script({ models })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Images', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Images', modelId: f.modelId })
  return f
}

it('uses each model catalog entry, including future models and the legacy image default', async () => {
  const models = [
    { model: 'fixture-model', displayName: 'Vision', inputModalities: ['text', 'image'] },
    { model: 'future-model', displayName: 'Future', inputModalities: ['audio', 'image'] },
    { model: 'legacy-model', displayName: 'Legacy' },
    { model: 'text-model', displayName: 'Text', inputModalities: ['text'] },
    { model: 'empty-model', displayName: 'Empty', inputModalities: [] },
    { model: 'hidden-model', displayName: 'Hidden', inputModalities: ['image'], hidden: true },
  ]
  const f = await fixture(models)
  expect((await f.host.snapshot()).models.map(model => [model.id, model.supportsImages])).toEqual([
    ['fixture-model', true], ['future-model', true], ['legacy-model', true], ['text-model', false], ['empty-model', false],
  ])
})

it('discovers image capability on every catalog page without relying on a model name list', async () => {
  const f = await codexFixture(); fixtures.push(f)
  await f.script({ modelPages: {
    first: { data: [{ model: 'text-only', displayName: 'Text only', inputModalities: ['text'] }], nextCursor: 'more' },
    more: { data: [{ model: 'new-vision-model', displayName: 'New vision model', inputModalities: ['image', 'text'] }], nextCursor: null },
  } })
  const snapshot = await f.host.connect()
  expect(snapshot.models.map(model => [model.id, model.supportsImages])).toEqual([['text-only', false], ['new-vision-model', true]])
  expect((await f.driver.requests()).filter(request => request.method === 'model/list').map(request => request.params?.cursor)).toEqual([undefined, 'more'])
})

it('rejects a repeating catalog cursor without publishing an incomplete capability list', async () => {
  const f = await codexFixture(); fixtures.push(f)
  const model = { model: 'vision', displayName: 'Vision', inputModalities: ['image'] }
  await f.script({ modelPages: { first: { data: [model], nextCursor: 'repeat' }, repeat: { data: [model], nextCursor: 'repeat' } } })
  const snapshot = await f.host.connect()
  expect(snapshot.models).toEqual([])
  expect(snapshot.error).toContain('models could not be listed')
  expect((await f.driver.requests()).filter(request => request.method === 'model/list')).toHaveLength(2)
})

it('sends image-only input, steers with another screenshot, and restores both receipts without replay or raw image persistence', async () => {
  const f = await fixture()
  const first = { type: 'send' as const, commandId: 'image-send', messageId: 'image-message', threadId: 'thread', text: '', attachments: [image] }
  expect(await f.host.execute(first)).toEqual({ accepted: true })
  const second = { type: 'steer' as const, commandId: 'image-steer', messageId: 'steer-message', threadId: 'thread', text: 'Compare these', attachments: [{ ...image, id: 'shot-2', name: 'Second.png' }] }
  expect(await f.host.execute(second)).toEqual({ accepted: true })
  for (const method of ['turn/start', 'turn/steer']) {
    expect((await f.driver.requests()).find(request => request.method === method)?.params?.input).toContainEqual({ type: 'image', url: image.dataUrl })
  }
  await f.driver.completeTurn('thread', 'Compared')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  await f.script({ historyItemIds: true })
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  const restored = await f.adapter.refreshThread('thread')
  expect(restored.threads[0]?.messages.filter(message => message.role === 'user')).toEqual([
    expect.objectContaining({ id: first.messageId, commandId: first.commandId, text: '', attachments: [reference(image)] }),
    expect.objectContaining({ id: second.messageId, commandId: second.commandId, text: second.text, attachments: [reference(second.attachments[0]!)] }),
  ])
  expect(await f.host.execute(first)).toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(1)
  const aliases = await readFile(join(f.root, 'codex-threads.json'), 'utf8')
  expect(aliases).not.toContain(image.dataUrl)
  expect(aliases).not.toContain(first.text || second.text)
})

it('reconciles a screenshot with a lost acknowledgement instead of sending it twice', async () => {
  const f = await fixture()
  const command = { type: 'send' as const, commandId: 'uncertain', messageId: 'uncertain-message', threadId: 'thread', text: '', attachments: [image] }
  await f.driver.delayNextAck('turn/start')
  expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  await f.adapter.refreshThread('thread')
  expect(await f.host.execute(command)).toEqual({ accepted: true })
  expect((await f.host.snapshot()).threads[0]?.messages).toContainEqual(expect.objectContaining({ id: command.messageId, attachments: [reference(image)] }))
  expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(1)
})

it('accepts a full 20 MiB batch and accumulated image history across steering, later turns and reconnect', async () => {
  const f = await fixture(undefined, 15_000)
  const bytes = Buffer.alloc(AGENT_MAX_IMAGE_BYTES)
  Buffer.from(image.dataUrl.split(',')[1]!, 'base64').copy(bytes)
  const large = { ...image, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }
  const attachments = [large, { ...large, id: 'shot-2' }]
  const result = await f.host.execute({ type: 'send', commandId: 'large', messageId: 'large-message', threadId: 'thread', text: 'Large screenshots', attachments })
  expect(result).toEqual({ accepted: true })
  expect((await f.adapter.refreshThread('thread')).threads[0]?.messages).toContainEqual(expect.objectContaining({ id: 'large-message', attachments: attachments.map(reference) }))
  const followup = { ...image, dataUrl: 'data:image/png;base64,' + bytes.subarray(0, 2 * 1024 * 1024).toString('base64') }
  expect(await f.host.execute({ type: 'steer', commandId: 'large-steer', messageId: 'steer-message', threadId: 'thread', text: '', attachments: [followup] })).toEqual({ accepted: true })
  await f.driver.completeTurn('thread', 'Compared the screenshots')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  expect(await f.host.execute({ type: 'send', commandId: 'later-image', messageId: 'later-message', threadId: 'thread', text: '', attachments: [followup] })).toEqual({ accepted: true })
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  const restored = await f.adapter.refreshThread('thread')
  expect(restored.connected).toBe(true)
  expect(restored.threads[0]?.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['large-message', 'steer-message', 'later-message'])
}, 60_000)
