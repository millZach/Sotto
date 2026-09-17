// @vitest-environment node
/**
 * The short-text writing path: one line of text from a small OpenRouter model, the prompt that names a
 * thread from its first exchange, and the promise that every failure resolves to null instead of an error.
 */
import { describe, expect, it, vi } from 'vitest'

import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { THREAD_TITLE_MAX_CHARACTERS, threadTitleRequest, threadTitleWriter } from '../../../src/main/llm/threadTitle'
import { COMMIT_DIFF_MAX_CHARACTERS, COMMIT_SUBJECT_MAX_CHARACTERS, commitMessageRequest, commitMessageWriter, stagedDiffExcerpt } from '../../../src/main/llm/commitMessage'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const KEYED: AppSettings = { ...DEFAULT_SETTINGS, llmApiKey: 'sk-or-v1-test', writingModel: 'anthropic/claude-haiku-4.5' }

const answer = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })

function createWriter(options: { settings?: AppSettings; fetchFn?: typeof fetch } = {}) {
  const fetchFn = vi.fn(options.fetchFn ?? (async () => answer('Palette contrast pass')))
  const failures: string[] = []
  const writer = new ShortTextWriter({
    getSettings: () => options.settings ?? KEYED,
    fetchFn,
    onFailure: failure => failures.push(`${failure.purpose}:${failure.reason}`),
  })
  return { fetchFn, failures, writer }
}

const body = (fetchFn: ReturnType<typeof vi.fn>): { model: string; messages: { role: string; content: string }[]; max_tokens: number } =>
  JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))

const exchange = { prompt: 'The palette is unreadable in dark mode.', reply: 'I raised the foreground contrast on the two dark themes.' }

describe('the short-text writing path', () => {
  it('sends the chosen writing model with the stored key and returns the trimmed line', async () => {
    const { fetchFn, writer } = createWriter()
    await expect(writer.write(threadTitleRequest(exchange))).resolves.toBe('Palette contrast pass')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const request = fetchFn.mock.calls[0]![1]!
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-test')
    expect(body(fetchFn).model).toBe('anthropic/claude-haiku-4.5')
  })

  it('carries the first message and the first reply, and nothing else', async () => {
    const { fetchFn, writer } = createWriter()
    await writer.write(threadTitleRequest(exchange))
    const sent = body(fetchFn).messages
    const material = sent.find(message => message.role === 'user')!.content
    expect(material).toContain(exchange.prompt)
    expect(material).toContain(exchange.reply)
    expect(material).not.toContain('sk-or-v1-test')
    expect(sent).toHaveLength(2)
  })

  it('takes the first line, drops quotes and a trailing period, and cuts an over-long name at a word', async () => {
    const cases: [string, string][] = [
      ['"Palette contrast pass."', 'Palette contrast pass'],
      ['Palette contrast pass\nHere is why I chose it.', 'Palette contrast pass'],
      ['   \n  Palette   contrast  pass  ', 'Palette contrast pass'],
    ]
    for (const [content, expected] of cases) {
      const { writer } = createWriter({ fetchFn: async () => answer(content) })
      await expect(writer.write(threadTitleRequest(exchange))).resolves.toBe(expected)
    }
    const long = createWriter({ fetchFn: async () => answer('Raise the foreground contrast of every dark theme so the palette can be read again') })
    const title = await long.writer.write(threadTitleRequest(exchange))
    expect(title!.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_CHARACTERS)
    expect(title).not.toMatch(/\s$/u)
    expect('Raise the foreground contrast of every dark theme so the palette can be read again').toContain(title!)
  })

  it('asks for nothing without an OpenRouter key, and resolves to null on every failure', async () => {
    const keyless = createWriter({ settings: { ...KEYED, llmApiKey: '' } })
    await expect(keyless.writer.write(threadTitleRequest(exchange))).resolves.toBeNull()
    expect(keyless.fetchFn).not.toHaveBeenCalled()
    expect(keyless.failures).toEqual(['thread-title:no-key'])

    const refused = createWriter({ fetchFn: async () => new Response('no', { status: 402 }) })
    await expect(refused.writer.write(threadTitleRequest(exchange))).resolves.toBeNull()
    expect(refused.failures).toEqual(['thread-title:http-402'])

    const offline = createWriter({ fetchFn: () => Promise.reject(new Error('offline')) })
    await expect(offline.writer.write(threadTitleRequest(exchange))).resolves.toBeNull()
    expect(offline.failures).toEqual(['thread-title:network'])

    const empty = createWriter({ fetchFn: async () => answer('   ') })
    await expect(empty.writer.write(threadTitleRequest(exchange))).resolves.toBeNull()
    expect(empty.failures).toEqual(['thread-title:empty'])
  })

  it('asks for nothing while generated titles are off', async () => {
    const { fetchFn, writer } = createWriter()
    const off = threadTitleWriter(writer, () => ({ ...KEYED, threadTitles: false }))
    await expect(off(exchange)).resolves.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    await expect(threadTitleWriter(writer, () => KEYED)(exchange)).resolves.toBe('Palette contrast pass')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

const excerpt = { diff: 'diff --git a/src/app.ts b/src/app.ts\n+export const ready = true\n', truncated: false }

describe('the commit message a staged diff earns', () => {
  it('carries the staged diff alone, and the note when it was cut', async () => {
    const { fetchFn, writer } = createWriter({ fetchFn: async () => answer('Raise the dark palette contrast') })
    await expect(commitMessageWriter(writer, () => KEYED)(excerpt)).resolves.toBe('Raise the dark palette contrast')
    const sent = body(fetchFn).messages
    const material = sent.find(message => message.role === 'user')!.content
    expect(material).toContain('+export const ready = true')
    expect(material).not.toContain('sk-or-v1-test')
    expect(material).not.toMatch(/continues past this point/u)
    expect(sent).toHaveLength(2)
    expect(commitMessageRequest({ ...excerpt, truncated: true }).material).toMatch(/continues past this point/u)
    expect(stagedDiffExcerpt('a\n'.repeat(COMMIT_DIFF_MAX_CHARACTERS))).toMatchObject({ truncated: true })
    expect(stagedDiffExcerpt('a\n'.repeat(COMMIT_DIFF_MAX_CHARACTERS)).diff.length).toBeLessThanOrEqual(COMMIT_DIFF_MAX_CHARACTERS)
  })

  it('keeps a short body, shortens an over-long subject and drops a fence', async () => {
    const fenced = createWriter({ fetchFn: async () => answer('```\nAdd the commit draft to the Changes panel.\n\nThe staged diff is the only material sent.\n```') })
    await expect(commitMessageWriter(fenced.writer, () => KEYED)(excerpt)).resolves
      .toBe('Add the commit draft to the Changes panel\n\nThe staged diff is the only material sent.')
    const long = createWriter({ fetchFn: async () => answer('Subject: Draft the commit message from the staged diff so the Changes panel opens with words already written') })
    const message = await commitMessageWriter(long.writer, () => KEYED)(excerpt)
    expect(message!.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX_CHARACTERS)
    expect(message).toBe('Draft the commit message from the staged diff so the Changes panel')
  })

  it('asks for nothing while generated commit messages are off or no key is stored', async () => {
    const off = createWriter()
    await expect(commitMessageWriter(off.writer, () => ({ ...KEYED, commitMessages: false }))(excerpt)).resolves.toBeNull()
    expect(off.fetchFn).not.toHaveBeenCalled()
    const keyless = createWriter({ settings: { ...KEYED, llmApiKey: '' } })
    await expect(commitMessageWriter(keyless.writer, () => ({ ...KEYED, llmApiKey: '' }))(excerpt)).resolves.toBeNull()
    expect(keyless.fetchFn).not.toHaveBeenCalled()
    expect(keyless.failures).toEqual(['commit-message:no-key'])
  })
})
