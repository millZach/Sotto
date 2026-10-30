// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeDigest, claudeReadBack, ClaudeSessionLog, claudeText, claudeUserText, firstUnread, type OriginBucket } from '../../../src/main/agents/claudeSessionLog'
import { attachedFilesNote, browserFeedbackNote } from '../../../src/main/agents/attachedFiles'
import { CLAUDE_MAX_FRAME_BYTES, type ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-log-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const entry = (session: string, text: string): string =>
  `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })}\n`

async function transcript(): Promise<{ home: string; cwd: string; session: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-log-')); roots.push(root)
  const home = join(root, 'home'), cwd = join(root, 'work'), session = randomUUID()
  const folder = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${session}.jsonl`)
  await writeFile(path, '')
  return { home, cwd, session, path }
}

describe('Claude session log cursor', () => {
  it('finds the native project folder for an astral character', async () => {
    const { home, cwd, session } = await transcript()
    const project = join(cwd, 'work-\u{1f600}')
    const folder = join(home, 'projects', `${cwd.replace(/[^a-zA-Z0-9]/gu, '-')}-work---`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${session}.jsonl`), entry(session, 'Native transcript'))
    const frames: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, project, session, frame => frames.push(frame))
    expect(await reader.exists()).toBe(true)
    await reader.poll()
    expect(frames).toHaveLength(1)
  })
  it('resumes at a stored cursor and reads only what was appended', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    expect(first).toHaveLength(2)
    const cursor = reader.cursor()!
    expect(cursor.offset).toBe(cursor.size)

    await appendFile(path, entry(session, 'Third'))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Third'])
  })

  it('stores the offset after the last complete line, so a half-written entry is read whole next time', async () => {
    const { home, cwd, session, path } = await transcript()
    const complete = entry(session, 'First')
    const partial = entry(session, 'Second')
    await appendFile(path, complete + partial.slice(0, 20))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    expect(first).toHaveLength(1)
    const cursor = reader.cursor()!
    expect(cursor.offset).toBe(Buffer.byteLength(complete))

    await appendFile(path, partial.slice(20))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Second'])
  })

  // The reader looks for each line's end in the bytes of each read and decodes a line once, when it is whole (#992).
  it('reads a line written across many reads whole, with characters cut at their edges, and keeps the cursor on its end', async () => {
    const { home, cwd, session, path } = await transcript()
    // Two-byte and four-byte characters, so some reads end inside a character; 300,000 bytes crosses five reads.
    const long = entry(session, 'é😀'.repeat(50_000)), after = entry(session, 'After')
    await appendFile(path, long + after)
    const frames: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => frames.push(frame))
    await reader.poll()
    expect(frames.map(frame => (frame.message as { content: string }).content)).toEqual(['é😀'.repeat(50_000), 'After'])
    expect(reader.cursor()!.offset).toBe(Buffer.byteLength(long + after))
  })

  it('passes over a line too long to take, keeps its bytes in the cursor and reads the line after it', async () => {
    const { home, cwd, session, path } = await transcript()
    const huge = `${JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: 'x'.repeat(CLAUDE_MAX_FRAME_BYTES) } })}\n`
    const after = entry(session, 'After')
    await appendFile(path, huge + after)
    const frames: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => frames.push(frame))
    await reader.poll()
    expect(frames.map(frame => (frame.message as { content: string }).content)).toEqual(['After'])
    expect(reader.cursor()!.offset).toBe(Buffer.byteLength(huge + after))
  })

  it('reads from the first byte again when the file is not the one the cursor names', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    const cursor = reader.cursor()!

    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume({ ...cursor, ino: '999999999999', birthtimeMs: 1 })
    await resumed.poll()
    expect(second).toHaveLength(2)
  })

  it('reads from the first byte again when the transcript is shorter than the cursor saw', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const reader = new ClaudeSessionLog(home, cwd, session, () => undefined)
    await reader.poll()
    const cursor = reader.cursor()!

    await writeFile(path, entry(session, 'Only'))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Only'])
  })
})

describe('a Claude prompt read back with Point at something feedback (ADR-0154)', () => {
  const picture = { name: 'button · Sign in', mimeType: 'image/png', browserFeedback: { label: 'button · Sign in', comment: 'Match the header', context: 'Selector: #sign-in' } }
  const handwritten = '<sotto-browser-feedback>\nI typed this myself.\n</sotto-browser-feedback>'
  const recorded = [{ mimeType: 'image/png', pointed: true as const }]
  it('takes off only the block Sotto appended for that prompt, and keeps one the user wrote', () => {
    const note = browserFeedbackNote([picture])
    // As Claude Code is sent it: the picture, the user's words (here only a block they typed), then Sotto's note.
    const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: handwritten }, { type: 'text', text: note }]
    expect(claudeUserText(content, recorded)).toBe(handwritten)
    // A prompt sent as one text keeps the user's block too.
    expect(claudeUserText(`Look\n\n${handwritten}\n\n${note}`, recorded)).toBe(`Look\n\n${handwritten}`)
    // With no picture recorded, Sotto appended nothing, so nothing comes off.
    expect(claudeUserText([{ type: 'text', text: 'Look' }, { type: 'text', text: handwritten }], [{ mimeType: 'image/png' }])).toBe(`Look\n${handwritten}`)
  })
  it('takes Sotto\'s note off the end of the user\'s own text block when it was appended inside it', () => {
    const note = browserFeedbackNote([picture])
    const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: `Look\n\n${handwritten}\n\n${note}` }]
    expect(claudeUserText(content, recorded)).toBe(`Look\n\n${handwritten}`)
  })
  // An origin as the Claude adapter records it for a prompt sent with notes: the digest of the user's words, and the
  // digest and notes' length of the whole text delivered, flattened as the log reads it back.
  const sent = (uuid: string, content: unknown[], words: string) => {
    const flattened = claudeText(content)
    return { uuid, digest: claudeDigest(words), attachments: recorded, delivered: { digest: claudeDigest(flattened), suffixLength: flattened.length - words.length } }
  }
  // A lookup that answers both digests an origin holds, as a scan over every origin might, and counts its calls.
  const lookup = (...origins: ReturnType<typeof sent>[]) => {
    const calls: string[] = []
    const find = (digest: string) => { calls.push(digest); return origins.find(origin => origin.digest === digest || origin.delivered.digest === digest) }
    return { find, calls }
  }
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }

  it('finds an origin with no frame ID by the exact text Sotto delivered, and takes off exactly its notes', () => {
    const note = browserFeedbackNote([picture])
    // The user's prompt is only a block they typed in the note's shape, then Sotto's note in a part of its own.
    const typedOnly = [image, { type: 'text', text: handwritten }, { type: 'text', text: note }]
    const typedOrigin = sent('typed-only', typedOnly, handwritten)
    expect(claudeReadBack(typedOnly, undefined, { delivered: lookup(typedOrigin).find })).toEqual({ text: handwritten, origin: typedOrigin })
    // A prompt sent as one text: words, the user's block, then Sotto's note.
    const words = `Look\n\n${handwritten}`
    const scalar = `${words}\n\n${note}`
    const scalarOrigin = { ...sent('scalar', [{ type: 'text', text: scalar }], words) }
    expect(claudeReadBack(scalar, undefined, { delivered: lookup(scalarOrigin).find })).toEqual({ text: words, origin: scalarOrigin })
  })

  it('keeps the words of parts that end in a line break, which flattening joins to the note (review item 2)', () => {
    const note = browserFeedbackNote([picture])
    const content = [image, { type: 'text', text: 'Look\n' }, { type: 'text', text: note }]
    const origin = sent('line-break', content, 'Look\n')
    expect(claudeReadBack(content, undefined, { delivered: lookup(origin).find })).toEqual({ text: 'Look\n', origin })
  })

  it('leaves native input alone when it only resembles a prompt Sotto sent with notes (review item 1)', () => {
    const note = browserFeedbackNote([picture])
    const words = `Plan\n\n${handwritten}`
    const origin = sent('pointed', [image, { type: 'text', text: words }, { type: 'text', text: note }], words)
    // Typed in Claude Code: the same words and block, then a second block the user wrote, with no picture sent.
    const typed = `${words}\n\n<sotto-browser-feedback>\nAnother block I typed.\n</sotto-browser-feedback>`
    expect(claudeReadBack([{ type: 'text', text: typed }], undefined, { delivered: lookup(origin).find })).toEqual({ text: typed, origin: undefined })
  })

  it('looks the origin up once per frame, whatever blocks the text ends with (review item 3)', () => {
    const note = browserFeedbackNote([picture])
    const blocks = Array.from({ length: 6 }, () => handwritten).join('\n\n')
    const { find, calls } = lookup()
    claudeReadBack([{ type: 'text', text: `${blocks}\n\n${note}` }], undefined, { delivered: find })
    expect(calls).toHaveLength(1)
  })

  it('reads back an origin recorded before the delivered digest as it did then, by its words, once its file note comes off', () => {
    const note = attachedFilesNote([{ relativePath: '.sotto/attachments/3f2a9c1e0b7d/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }])
    // A record from before the change: the words' digest and the attachments, no delivered digest.
    const legacy: { uuid: string; digest: string; attachments: { mimeType: string }[]; delivered?: { digest: string; suffixLength: number } } = { uuid: 'legacy', digest: claudeDigest('Read this'), attachments: [{ mimeType: 'application/pdf' }] }
    const calls: string[] = []
    const byWords = (digest: string) => { calls.push(digest); return digest === legacy.digest ? legacy : undefined }
    expect(claudeReadBack([{ type: 'text', text: 'Read this' }, { type: 'text', text: note }], undefined, { delivered: () => undefined, legacy: byWords })).toEqual({ text: 'Read this', origin: legacy })
    expect(calls).toHaveLength(1)
  })

  it('never takes the words path for an origin that has a delivered digest, so look-alike native input stays as typed', () => {
    const note = browserFeedbackNote([picture])
    // Sotto sent "Plan" with a picture; the user then typed "Plan" and a block of their own in Claude Code, as one text.
    const origin = sent('pointed', [image, { type: 'text', text: 'Plan' }, { type: 'text', text: note }], 'Plan')
    const typed = `Plan\n\n${handwritten}`
    // Taking every note-shaped block off leaves "Plan", whose digest is the origin's words; a words lookup that answers
    // this origin still cannot claim the native input, since the origin has a delivered digest.
    const { find } = lookup(origin)
    expect(claudeReadBack(typed, undefined, { delivered: find, legacy: find })).toEqual({ text: typed, origin: undefined })
  })

  it('lets a newer prompt whose words are the text as read win over an older origin found by taking blocks off (review 6, item 1)', () => {
    // An older origin, from before the delivered digest, sent "Plan" with a picture and not read back yet.
    type Recorded = { uuid: string; digest: string; attachments?: { mimeType: string; pointed?: true }[] }
    const legacy: Recorded = { uuid: 'legacy', digest: claudeDigest('Plan'), attachments: [{ mimeType: 'image/png', pointed: true as const }] }
    // A newer prompt, with no attachments, whose words are "Plan" and a block the user typed in a note's shape.
    const typed = `Plan\n\n${handwritten}`
    const newer: Recorded = { uuid: 'newer', digest: claudeDigest(typed) }
    const lookups = {
      words: (digest: string) => [legacy, newer].find(origin => origin.digest === digest),
      legacy: (digest: string) => digest === legacy.digest ? legacy : undefined,
    }
    expect(claudeReadBack(typed, undefined, lookups)).toEqual({ text: typed, origin: undefined })
  })

  it('takes exactly the delivered notes off for a frame its ID names, keeping the words\' own line break (review 6, item 3)', () => {
    const note = browserFeedbackNote([picture])
    const origin = sent('known', [image, { type: 'text', text: 'Look\n' }, { type: 'text', text: note }], 'Look\n')
    // Read back as one text: the words' line break and the separator run together before the note.
    expect(claudeReadBack(`Look\n\n${note}`, origin)).toEqual({ text: 'Look\n', origin })
  })

  it('passes origins already read back once and for all, so a lookup does not grow with them (review 6, item 2)', () => {
    const origins = Array.from({ length: 10_000 }, (_, at) => ({ uuid: `sent-${at}` }))
    let checks = 0
    class Counted extends Set<string> { override has(value: string): boolean { checks++; return super.has(value) } }
    const consumed = new Counted(origins.slice(0, 9_998).map(origin => origin.uuid))
    const bucket: OriginBucket<{ uuid: string }> = { origins, start: 0, consumed: undefined }
    expect(firstUnread(bucket, consumed)).toBe(origins[9_998])
    checks = 0
    consumed.add('sent-9998')
    expect(firstUnread(bucket, consumed)).toBe(origins[9_999])
    expect(checks).toBeLessThanOrEqual(3)
    // The log read again from its start: a new set, and the cursor starts again.
    expect(firstUnread(bucket, new Set())).toBe(origins[0])
  })
})
