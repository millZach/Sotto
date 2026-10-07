// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RetiredChatHistory } from '../../../src/main/settings/retiredChats'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const crashCopy = 'chats.json.tmp-123-12345678-1234-1234-1234-123456789abc'
function saved() {
  const request = { id: 'request', kind: 'question', text: 'private question', options: [] }
  return { selectedChatId: 'chat', chats: [{
    id: 'chat', kind: 'personal', providerId: 'codex', title: 'private title', modelId: 'model', status: 'idle',
    createdAt: 'then', updatedAt: 'now', nativeState: 'ready', connected: false,
    messages: [{ id: 'message', role: 'user', text: 'private transcript', createdAt: 'then' }], requests: [request],
    activities: [{ id: 'activity', turnId: 'turn', sequence: 0, kind: 'reasoning', status: 'completed', title: 'private activity' }],
    draft: { revision: 2, text: 'unsent draft', skills: [] },
    submissions: [{ id: 'submission', messageId: 'message', revision: 1, text: 'submitted prompt', skills: [], status: 'uncertain', createdAt: 'then' }],
    decisions: [{ id: 'decision', requestId: 'request', request, questionsDigest: 'a'.repeat(64), answer: 'private answer',
      questionAnswers: { question: { optionIds: [], text: 'private structured answer' } }, permissionChoice: 'allow-once',
      status: 'uncertain', createdAt: 'then', error: 'private diagnostic' }],
  }] }
}
async function fixture(source: string = JSON.stringify(saved())) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-retired-chat-'))
  directories.push(directory)
  const personal = join(directory, 'personal-chat')
  await mkdir(personal)
  const path = join(personal, 'chats.json')
  await writeFile(path, source)
  return { directory, personal, path }
}

it.each([JSON.stringify(saved(), null, 3), '{not valid'])('leaves every byte and abandoned copy alone while local history is on', async source => {
  const { directory, personal, path } = await fixture(source)
  await writeFile(join(personal, crashCopy), 'private abandoned copy')
  const store = { write: vi.fn(async () => undefined) }
  await new RetiredChatHistory(directory, () => true, store).privacyChanged()
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(await readFile(join(personal, crashCopy), 'utf8')).toBe('private abandoned copy')
  expect(store.write).not.toHaveBeenCalled()
})

it('redacts the original transcript and submitted-answer fields while retaining the unsent draft and delivery identity', async () => {
  const { directory, personal, path } = await fixture()
  await writeFile(join(personal, crashCopy), 'private abandoned copy')
  const preserved = ['chats.json.corrupt-123', 'chats.json.tmp-other', 'chats.json.tmp-123-12345678-1234-1234-1234-123456789abc-extra']
  await Promise.all(preserved.map(name => writeFile(join(personal, name), 'unrelated file')))
  await mkdir(join(personal, 'codex'))
  await writeFile(join(personal, 'codex', 'native.json'), 'native provider history')
  const history = new RetiredChatHistory(directory, () => false)
  await history.privacyChanged()
  const result = JSON.parse(await readFile(path, 'utf8'))
  expect(result.selectedChatId).toBe('chat')
  expect(result.chats[0]).toMatchObject({ title: 'Personal chat', messages: [], requests: [], nativeState: 'ready',
    draft: { revision: 2, text: 'unsent draft', skills: [] },
    submissions: [{ id: 'submission', messageId: 'message', revision: 1, text: '', skills: [], status: 'uncertain', createdAt: 'then' }],
    decisions: [{ id: 'decision', requestId: 'request', questionsDigest: 'a'.repeat(64), status: 'uncertain', createdAt: 'then', answer: '', error: 'Answer could not be confirmed. Local history is off.' }],
  })
  expect(result.chats[0]).not.toHaveProperty('activities')
  expect(Object.keys(result.chats[0].decisions[0]).sort()).toEqual(['answer', 'createdAt', 'error', 'id', 'questionsDigest', 'requestId', 'status'])
  expect(await readdir(personal)).toEqual(expect.arrayContaining(['chats.json', 'codex', ...preserved]))
  expect(await readdir(personal)).not.toContain(crashCopy)
  expect(await readFile(join(personal, 'codex', 'native.json'), 'utf8')).toBe('native provider history')
  const first = await readFile(path, 'utf8')
  await history.privacyChanged()
  expect(await readFile(path, 'utf8')).toBe(first)
})

it.each(['{broken', JSON.stringify({ selectedChatId: null, chats: [{}] }), JSON.stringify({ ...saved(), chats: [saved().chats[0], saved().chats[0]] })])('does not reset, back up or sweep an invalid primary, then retries after repair', async source => {
  const { directory, personal, path } = await fixture(source)
  await writeFile(join(personal, crashCopy), 'private abandoned copy')
  const history = new RetiredChatHistory(directory, () => false)
  await expect(history.privacyChanged()).rejects.toThrow('could not be read safely')
  expect(await readFile(path, 'utf8')).toBe(source)
  expect((await readdir(personal)).sort()).toEqual(['chats.json', crashCopy])
  await writeFile(path, JSON.stringify(saved()))
  await history.privacyChanged()
  expect(JSON.parse(await readFile(path, 'utf8')).chats[0].messages).toEqual([])
  expect(await readdir(personal)).toEqual(['chats.json'])
})

it('leaves a missing primary missing and does not treat its abandoned copy as authoritative', async () => {
  const { directory, personal, path } = await fixture()
  await rm(path)
  await writeFile(join(personal, crashCopy), 'private abandoned copy')
  await new RetiredChatHistory(directory, () => false).privacyChanged()
  expect(await readdir(personal)).toEqual([crashCopy])
})

it('reports unreadable storage without revealing a body or resetting the primary', async () => {
  const { directory, path } = await fixture()
  await rm(path)
  await mkdir(path)
  await expect(new RetiredChatHistory(directory, () => false).privacyChanged()).rejects.toThrow('original personal-chat/chats.json is unchanged')
  expect(await readdir(path)).toEqual([])
})

it('preserves the primary and crash copy when atomic replacement fails, and retries later', async () => {
  const source = JSON.stringify(saved())
  const { directory, personal, path } = await fixture(source)
  await writeFile(join(personal, crashCopy), 'private abandoned copy')
  const store = { write: vi.fn(async () => undefined).mockRejectedValueOnce(new Error('private body')) }
  const history = new RetiredChatHistory(directory, () => false, store)
  await expect(history.privacyChanged()).rejects.toThrow('could not be cleared')
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(await readFile(join(personal, crashCopy), 'utf8')).toBe('private abandoned copy')
  await history.privacyChanged()
  expect(store.write).toHaveBeenCalledTimes(2)
  expect(await readdir(personal)).toEqual(['chats.json'])
})

it('strips unrecognized fields just as the original saved-chat schema did', async () => {
  const input = { ...saved(), unknownTranscript: 'private unknown text' }
  Object.assign(input.chats[0]!, { unknownTranscript: 'private unknown text' })
  const { directory, path } = await fixture(JSON.stringify(input))
  await new RetiredChatHistory(directory, () => false).privacyChanged()
  expect(await readFile(path, 'utf8')).not.toContain('unknownTranscript')
})

it('reports a failed crash-copy sweep after primary redaction and retries without restoring private content', async () => {
  const { directory, personal, path } = await fixture()
  const abandoned = join(personal, crashCopy)
  await mkdir(abandoned)
  const history = new RetiredChatHistory(directory, () => false)
  await expect(history.privacyChanged()).rejects.toThrow('could not be cleared')
  const redacted = await readFile(path, 'utf8')
  expect(JSON.parse(redacted).chats[0].messages).toEqual([])
  await rm(abandoned, { recursive: true })
  await writeFile(abandoned, 'private abandoned copy')
  await history.privacyChanged()
  expect(await readFile(path, 'utf8')).toBe(redacted)
  expect(await readdir(personal)).toEqual(['chats.json'])
})
