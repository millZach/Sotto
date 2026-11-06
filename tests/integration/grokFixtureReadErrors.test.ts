// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

const fault = vi.hoisted(() => ({ path: '', code: 'EACCES' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]) === fault.path) return Promise.reject(Object.assign(new Error('Synthetic fixture read failure'), { code: fault.code }))
    return actual.readFile(...args)
  } }
})

it.each(['EACCES', 'EBUSY'])('reports %s instead of claiming zero starts from a known log', async code => {
  const f = await grokFixture()
  const threadId = randomUUID(), nativeId = randomUUID()
  const requests = join(f.root, 'requests.jsonl')
  try {
    await writeFile(join(f.root, 'grok-threads.json'), JSON.stringify({ [threadId]: { grokSessionId: nativeId } }))
    await writeFile(requests, JSON.stringify({ method: 'session/load', params: { sessionId: nativeId } }) + '\n')
    expect(await f.sessions.starts(threadId)).toBe(1)
    expect(await readFile(requests, 'utf8')).toContain(nativeId)
    fault.path = requests; fault.code = code
    await expect(f.sessions.starts(threadId)).rejects.toMatchObject({ code })
    fault.path = ''
    expect(await f.sessions.starts(threadId)).toBe(1)
  } finally { fault.path = ''; await f.cleanup() }
})

it('treats only a genuinely missing initial request log as empty', async () => {
  const f = await grokFixture()
  try {
    await expect(readFile(join(f.root, 'requests.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.driver.requests()).toEqual([])
  } finally { await f.cleanup() }
})

it('reports an unreadable violation log instead of silently accepting the protocol trace', async () => {
  const f = await grokFixture()
  const path = join(f.root, 'violations.jsonl')
  const content = JSON.stringify({ reason: 'Synthetic invalid provider reply' }) + '\n'
  try {
    await writeFile(path, content)
    fault.path = path; fault.code = 'EACCES'
    await expect(f.driver.requests()).rejects.toMatchObject({ code: 'EACCES' })
    fault.path = ''
    expect(await readFile(path, 'utf8')).toBe(content)
    await expect(f.driver.requests()).rejects.toThrow('Invalid Grok reply')
  } finally { fault.path = ''; await writeFile(path, ''); await f.cleanup() }
})

// The fake appends each request as one line, so a read can land while the last line is still half-written (#1622).
it('leaves a request still being appended for the next read', async () => {
  const f = await grokFixture()
  const path = join(f.root, 'requests.jsonl')
  const known = { method: 'session/load', params: { sessionId: 'known-session' } }
  try {
    await writeFile(path, JSON.stringify(known) + '\n{"method":"session/pro')
    expect(await f.driver.requests()).toEqual([known])
  } finally { await f.cleanup() }
})

it('keeps a malformed finished line visible instead of discarding the recorded prefix', async () => {
  const f = await grokFixture()
  const path = join(f.root, 'requests.jsonl')
  const content = JSON.stringify({ method: 'session/load', params: { sessionId: 'known-session' } }) + '\n{"method":\n'
  try {
    await writeFile(path, content)
    await expect(f.driver.requests()).rejects.toBeInstanceOf(SyntaxError)
    expect(await readFile(path, 'utf8')).toBe(content)
  } finally { await f.cleanup() }
})
