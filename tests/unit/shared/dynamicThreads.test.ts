import { describe, expect, it } from 'vitest'
import { DEFAULT_DYNAMIC_THREADS, DYNAMIC_NOTE_MAX_CHARACTERS, dynamicNoteText, dynamicSessionAfterCompaction, isDynamicThread, OVERSEER_NOTE_OFF, overseerNoteChanged, overseerNoteFor, overseerNoteOn, OVERSEER_REASON_PREFIX, overseerInstructions, overseerSend, parseDynamicThreadSettings, whyNotDynamic } from '../../../src/shared/dynamicThreads'
import { isOwlFeatureEnabled } from '../../../src/shared/owlFeatures'

describe('Dynamic threads (ADR-0191)', () => {
  it('holds the feature in Owl until Zach sends it', () => {
    expect(isOwlFeatureEnabled('dynamic-threads', 'owl')).toBe(true)
    expect(isOwlFeatureEnabled('dynamic-threads', 'stable')).toBe(false)
  })

  it('has no allowed list until the user has seen one, and four workers at Extra high', () => {
    expect(DEFAULT_DYNAMIC_THREADS).toEqual({ highestEffort: 'xhigh', workersAtOnce: 4 })
    expect(parseDynamicThreadSettings(undefined)).toEqual(DEFAULT_DYNAMIC_THREADS)
    expect(parseDynamicThreadSettings({ providers: [], highestEffort: 'high', workersAtOnce: 2 })).toEqual({ providers: [], highestEffort: 'high', workersAtOnce: 2 })
  })

  it('loses only the value that is damaged', () => {
    expect(parseDynamicThreadSettings({ providers: ['claude', 'no-such-provider'], highestEffort: 'high', workersAtOnce: 2 })).toEqual({ highestEffort: 'high', workersAtOnce: 2 })
    expect(parseDynamicThreadSettings({ providers: ['claude'], highestEffort: 'very high', workersAtOnce: 2 })).toEqual({ providers: ['claude'], highestEffort: 'xhigh', workersAtOnce: 2 })
    expect(parseDynamicThreadSettings({ providers: ['claude'], highestEffort: 'high', workersAtOnce: 0 })).toEqual({ providers: ['claude'], highestEffort: 'high', workersAtOnce: 4 })
    expect(parseDynamicThreadSettings({ providers: ['codex', 'codex'], extra: true })).toEqual({ providers: ['codex'], ...DEFAULT_DYNAMIC_THREADS })
  })

  it.each([
    [{ providerId: 'grok' }, 'Only a Claude Code or Codex thread'],
    [{}, 'Only a Claude Code or Codex thread'],
    [{ providerId: 'claude', delegatedBy: 'parent' }, 'A thread another thread started'],
    [{ providerId: 'codex', remoteHost: { hostId: 'forge', name: 'forge' } }, 'A thread on another machine'],
    [{ providerId: 'codex', kind: 'personal' }, 'Only a thread in a project'],
    [{ providerId: 'codex', archivedAt: '2026-11-04T00:00:00.000Z' }, 'An archived thread'],
  ] as const)('says why %j cannot be Dynamic', (thread, words) => {
    expect(whyNotDynamic(thread as never)).toContain(words)
    expect(isDynamicThread({ ...thread, dynamic: true } as never, true)).toBe(false)
  })

  it('tells an overseer to hand work on, how to choose, and how to say it changed something itself', () => {
    const words = overseerInstructions()
    expect(words).toContain('You do no work yourself')
    expect(words).toContain('Call read_delegation with no delegation')
    expect(words).toContain(`"${OVERSEER_REASON_PREFIX}"`)
    expect(words).toContain('name its delegation in replaces')
    // No authority in it: the permission a worker gets is still the delegate tool's to hold.
    expect(words).not.toMatch(/approve|grant/iu)
  })

  it('owes a note only when the session and the thread disagree', () => {
    const thread = (dynamic: boolean, told?: boolean) => ({ providerId: 'claude', ...dynamic ? { dynamic: true } : {}, ...told === undefined ? {} : { dynamicSession: { created: false, told } } }) as never
    expect(overseerNoteFor(thread(true), true)).toBe(overseerNoteOn())
    expect(overseerNoteOn()).toContain(overseerInstructions())
    expect(overseerNoteFor(thread(true, false), true)).toBe(overseerNoteOn())
    expect(overseerNoteFor(thread(true, true), true)).toBeUndefined()
    expect(overseerNoteFor(thread(false, true), true)).toBe(OVERSEER_NOTE_OFF)
    expect(overseerNoteFor(thread(false), true)).toBeUndefined()
    expect(overseerNoteFor(thread(false, false), true)).toBeUndefined()
    // None at all with the feature off, whatever a saved record says.
    expect(overseerNoteFor(thread(true), false)).toBeUndefined()
    expect(overseerNoteFor(thread(false, true), false)).toBeUndefined()
  })

  it('keeps your note as written, up to its limit, and reads one of only spaces as none', () => {
    expect(parseDynamicThreadSettings({ ...DEFAULT_DYNAMIC_THREADS, note: 'Sol for reviews.\nOpus for debugging.' }).note).toBe('Sol for reviews.\nOpus for debugging.')
    expect(parseDynamicThreadSettings({ ...DEFAULT_DYNAMIC_THREADS, note: 'x'.repeat(DYNAMIC_NOTE_MAX_CHARACTERS + 50) }).note).toHaveLength(DYNAMIC_NOTE_MAX_CHARACTERS)
    expect(parseDynamicThreadSettings({ ...DEFAULT_DYNAMIC_THREADS, note: 42 })).toEqual(DEFAULT_DYNAMIC_THREADS)
    expect(parseDynamicThreadSettings({ ...DEFAULT_DYNAMIC_THREADS, note: '' })).toEqual(DEFAULT_DYNAMIC_THREADS)
    expect(dynamicNoteText('  Sol for reviews.  ')).toBe('Sol for reviews.')
    expect(dynamicNoteText(' \n ')).toBeUndefined()
    expect(dynamicNoteText(undefined)).toBeUndefined()
  })

  it('gives an overseer your note last in its instructions, as advice the limits still hold', () => {
    const words = overseerInstructions('Sol for reviews.')
    expect(words.startsWith(overseerInstructions())).toBe(true)
    expect(words.endsWith('Sol for reviews.')).toBe(true)
    expect(words).toContain('delegate still holds the allowed list and the limits')
    expect(overseerInstructions()).not.toContain('The user\'s note')
    expect(overseerNoteOn('Sol for reviews.')).toContain(words)
  })

  it('owes a note when your note changed since the session was told, and never while the thread is not Dynamic', () => {
    const note = { text: 'Sol for reviews.', digest: 'aaaaaaaaaaaaaaaa' }
    const thread = (dynamic: boolean, session?: object) => ({ providerId: 'claude', ...dynamic ? { dynamic: true } : {}, ...session ? { dynamicSession: session } : {} }) as never
    expect(overseerNoteFor(thread(true, { created: true, told: true, createdNote: note.digest, toldNote: note.digest }), true, note)).toBeUndefined()
    expect(overseerNoteFor(thread(true, { created: true, told: true }), true, note)).toBe(overseerNoteChanged(note.text))
    expect(overseerNoteChanged(note.text)).toContain('set aside any earlier note')
    expect(overseerNoteFor(thread(true, { created: true, told: true, toldNote: 'bbbbbbbbbbbbbbbb' }), true, note)).toBe(overseerNoteChanged(note.text))
    // Cleared: the overseer is told to set the old one aside.
    expect(overseerNoteFor(thread(true, { created: true, told: true, toldNote: note.digest }), true)).toBe(overseerNoteChanged(undefined))
    expect(overseerNoteChanged(undefined)).toBe('The user cleared their note. From this message on, set aside any earlier note from them.')
    // Turning on carries the note with the instructions; a thread that is not Dynamic hears nothing of it.
    expect(overseerNoteFor(thread(true), true, note)).toBe(overseerNoteOn(note.text))
    expect(overseerNoteFor(thread(false, { created: true, told: false, createdNote: note.digest }), true)).toBeUndefined()
    expect(overseerNoteFor(thread(true, { created: true, told: true }), false, note)).toBeUndefined()
  })

  it('tells a first message of a change since its process launched, and records the note each held', () => {
    const now = { text: 'Opus for debugging.', digest: 'bbbbbbbbbbbbbbbb' }
    const dynamic = { providerId: 'claude', dynamic: true } as never
    expect(overseerSend(dynamic, true, now, { launchedNote: 'aaaaaaaaaaaaaaaa' })).toEqual({ note: overseerNoteChanged(now.text),
      session: { created: true, told: true, createdNote: 'aaaaaaaaaaaaaaaa', toldNote: now.digest, noteHeard: true } })
    expect(overseerSend(dynamic, true, now, { launchedNote: now.digest })).toEqual({ session: { created: true, told: true, createdNote: now.digest, toldNote: now.digest } })
    expect(overseerSend(dynamic, true, undefined, { launchedNote: 'aaaaaaaaaaaaaaaa' }).note).toBe(overseerNoteChanged(undefined))
    expect(overseerSend(dynamic, true, undefined, { launchedNote: undefined })).toEqual({ session: { created: true, told: true } })
    // A first message on a thread that is not Dynamic keeps no record, as before.
    expect(overseerSend({ providerId: 'claude' } as never, true, now, { launchedNote: undefined })).toEqual({})
    expect(overseerSend(dynamic, false, now, { launchedNote: undefined })).toEqual({})
  })

  it('remembers a note heard in the conversation, owes it again after a compaction, and has a session that heard one set it aside when Dynamic comes back', () => {
    const note = { text: 'Sol for reviews.', digest: 'aaaaaaaaaaaaaaaa' }
    const thread = (dynamic: boolean, session: object) => ({ providerId: 'claude', ...dynamic ? { dynamic: true } : {}, dynamicSession: session }) as never
    // A change note goes, and the session heard it.
    expect(overseerSend(thread(true, { created: true, told: true }), true, note)).toEqual({ note: overseerNoteChanged(note.text), session: { created: true, told: true, toldNote: note.digest, noteHeard: true } })
    // Cleared, then compacted: its digests match its creation again, but the clearing is owed, once.
    const compacted = dynamicSessionAfterCompaction({ created: true, told: true, noteHeard: true })
    expect(compacted).toEqual({ created: true, told: true, noteHeard: true, noteOwed: true })
    expect(overseerSend(thread(true, compacted), true)).toEqual({ note: overseerNoteChanged(undefined), session: { created: true, told: true, noteHeard: true } })
    // Back on after a note was heard and cleared: the note that turns it on says to set the old one aside.
    expect(overseerSend(thread(true, { created: false, told: false, noteHeard: true }), true).note).toBe(overseerNoteOn(undefined, true))
    expect(overseerNoteOn(undefined, true)).toContain('Set aside any earlier note from the user')
    expect(overseerSend(thread(true, { created: true, told: false, createdNote: note.digest }), true, note).note).toBe(overseerNoteOn(note.text, true))
    expect(overseerNoteOn(note.text)).not.toContain('Set aside')
    // The note that turns it on with a note in it is heard; one that turns it off keeps what was.
    expect(overseerSend(thread(true, { created: false, told: false }), true, note).session).toEqual({ created: false, told: true, toldNote: note.digest, noteHeard: true })
    expect(overseerSend(thread(false, { created: false, told: true, toldNote: note.digest }), true, note)).toEqual({ note: OVERSEER_NOTE_OFF, session: { created: false, told: false } })
  })

  it('goes back to what a session was created with after a compaction, note and all', () => {
    expect(dynamicSessionAfterCompaction({ created: true, told: true, createdNote: 'aaaaaaaaaaaaaaaa', toldNote: 'bbbbbbbbbbbbbbbb' })).toEqual({ created: true, told: true, createdNote: 'aaaaaaaaaaaaaaaa', toldNote: 'aaaaaaaaaaaaaaaa' })
    expect(dynamicSessionAfterCompaction({ created: true, told: true, toldNote: 'bbbbbbbbbbbbbbbb' })).toEqual({ created: true, told: true })
    expect(dynamicSessionAfterCompaction({ created: false, told: true, toldNote: 'bbbbbbbbbbbbbbbb' })).toEqual({ created: false, told: false })
  })

  it('reads the mark only on a thread that can hold it, while the feature is on', () => {
    expect(whyNotDynamic({ providerId: 'claude' } as never)).toBeUndefined()
    expect(isDynamicThread({ providerId: 'claude', dynamic: true } as never, true)).toBe(true)
    expect(isDynamicThread({ providerId: 'codex', dynamic: true } as never, true)).toBe(true)
    expect(isDynamicThread({ providerId: 'claude' } as never, true)).toBe(false)
    expect(isDynamicThread({ providerId: 'claude', dynamic: true } as never, false)).toBe(false)
  })
})
