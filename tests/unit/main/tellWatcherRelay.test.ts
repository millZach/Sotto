// @vitest-environment node
// `watcher-tell`, each side (ADR-0073, amendment of November 2, 2026): a thread on a host reaches a desktop's Watcher.
import { describe, expect, it, vi } from 'vitest'
import { DesktopTellWatcherRelay, HostTellWatcherRelay, type TellWatcherDesktop } from '../../../src/main/agents/tellWatcherRelay'
import { cutToBytes, namesWatcher, plainWords, toldUserMessage, TELL_WATCHER_WORDS_BYTES_MAX, type TellWatcherAnswer, type TellWatcherAsk } from '../../../src/shared/tellWatcher'

const ASK: TellWatcherAsk = { threadId: 't1', words: 'Synthetic words' }
const desktop = (relay: HostTellWatcherRelay, clientId: string, answer: TellWatcherAnswer | null, took = true): TellWatcherDesktop & { asks: string[] } => {
  const asks: string[] = []
  return { clientId, asks, push(askId) { asks.push(askId); if (answer) queueMicrotask(() => relay.answered({ clientId }, askId, answer)); return took } }
}

describe('HostTellWatcherRelay', () => {
  it('refuses with no desktop connected', async () => {
    await expect(new HostTellWatcherRelay().tell(ASK)).resolves.toEqual({ status: 'refused', reason: 'not-connected' })
  })
  it('asks the newest desktop first, and the next when that one has no Watcher', async () => {
    const relay = new HostTellWatcherRelay()
    const older = desktop(relay, 'older', { status: 'told', requestOpened: true }), newer = desktop(relay, 'newer', { status: 'refused', reason: 'no-watcher' })
    relay.desktopConnected(older); relay.desktopConnected(newer)
    await expect(relay.tell(ASK)).resolves.toEqual({ status: 'told', requestOpened: true })
    expect([newer.asks.length, older.asks.length]).toEqual([1, 1])
  })
  it('says no Watcher when every desktop says so', async () => {
    const relay = new HostTellWatcherRelay()
    relay.desktopConnected(desktop(relay, 'one', { status: 'refused', reason: 'no-watcher' }))
    await expect(relay.tell(ASK)).resolves.toEqual({ status: 'refused', reason: 'no-watcher' })
  })
  it('says not connected when a desktop’s socket refuses the push, and asks the next', async () => {
    const relay = new HostTellWatcherRelay()
    const older = desktop(relay, 'older', { status: 'told', requestOpened: false }), shut = desktop(relay, 'shut', null, false)
    relay.desktopConnected(older); relay.desktopConnected(shut)
    await expect(relay.tell(ASK)).resolves.toEqual({ status: 'told', requestOpened: false })
    relay.desktopGone(older)
    await expect(relay.tell(ASK)).resolves.toEqual({ status: 'refused', reason: 'not-connected' })
  })
  it('asks no other desktop once one has not answered, since it may have taken it', async () => {
    vi.useFakeTimers()
    try {
      const relay = new HostTellWatcherRelay()
      const older = desktop(relay, 'older', { status: 'told', requestOpened: true }), silent = desktop(relay, 'silent', null)
      relay.desktopConnected(older); relay.desktopConnected(silent)
      const pending = relay.tell(ASK)
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toEqual({ status: 'refused', reason: 'no-answer' })
      expect(older.asks).toEqual([])
    } finally { vi.useRealTimers() }
  })
  it('has no answer when the desktop goes while it waits', async () => {
    const relay = new HostTellWatcherRelay(), gone = desktop(relay, 'gone', null)
    relay.desktopConnected(gone)
    const pending = relay.tell(ASK)
    relay.desktopGone(gone)
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'no-answer' })
  })
  it('takes an answer only from the desktop it asked, and only one it can read', async () => {
    const relay = new HostTellWatcherRelay(), one = desktop(relay, 'one', null)
    relay.desktopConnected(one)
    const pending = relay.tell(ASK)
    expect(relay.answered({ clientId: 'someone-else' }, one.asks[0]!, { status: 'told', requestOpened: true })).toBe(false)
    expect(relay.answered({ clientId: 'one' }, one.asks[0]!, { status: 'told', requestOpened: 'yes' })).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'no-answer' })
  })
})

describe('DesktopTellWatcherRelay', () => {
  const connection = (hostId = 'host-1') => {
    let listener: ((askId: string, ask: TellWatcherAsk) => void) | undefined
    const answers: [string, TellWatcherAnswer][] = []
    return { kind: 'remote', hostId, answers, say: (askId: string, ask: unknown) => listener?.(askId, ask as TellWatcherAsk), service: {
      subscribeWatcherTell: (next: (askId: string, ask: TellWatcherAsk) => void) => { listener = next; return () => undefined },
      answerWatcherTell: async (askId: string, answer: TellWatcherAnswer) => { answers.push([askId, answer]) } } }
  }
  it('names the thread by the connection it came over, so a host speaks only for its own threads', async () => {
    const tell = vi.fn(async (): Promise<TellWatcherAnswer> => ({ status: 'told', requestOpened: false })), one = connection()
    new DesktopTellWatcherRelay(tell).useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [one] })
    one.say('a1', ASK)
    await vi.waitFor(() => expect(one.answers).toEqual([['a1', { status: 'told', requestOpened: false }]]))
    expect(tell).toHaveBeenCalledWith({ hostId: 'host-1', threadId: 't1' }, ASK)
  })
  it('answers an ask it cannot read as no Watcher, and hears a connection once', async () => {
    const tell = vi.fn(async (): Promise<TellWatcherAnswer> => ({ status: 'told', requestOpened: false })), one = connection()
    const relay = new DesktopTellWatcherRelay(tell)
    relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [one, one, { kind: 'local', hostId: 'here', service: {} }] })
    one.say('a2', { threadId: 't1' })
    await vi.waitFor(() => expect(one.answers).toEqual([['a2', { status: 'refused', reason: 'no-watcher' }]]))
    expect(tell).not.toHaveBeenCalled()
  })
})

describe('the user’s own message', () => {
  it('names Watcher however it was typed, and not by a word that merely contains it', () => {
    for (const text of ['Tell watcher', 'ask Watcher.', 'WATCHER: do this', 'tell the watcher, please']) expect(namesWatcher(text)).toBe(true)
    for (const text of ['Fix the file watchers', 'bird-watcher2', 'Carry on']) expect(namesWatcher(text)).toBe(false)
  })
  it('reads the whole message for the name, and cuts what it carries', () => {
    const long = `${'é'.repeat(TELL_WATCHER_WORDS_BYTES_MAX)} tell watcher`
    const told = toldUserMessage('m1', long)!
    expect(told).toMatchObject({ named: true, cut: true })
    expect(Buffer.byteLength(told.words)).toBeLessThanOrEqual(TELL_WATCHER_WORDS_BYTES_MAX)
    expect(told.words.endsWith('�')).toBe(false)
    expect(toldUserMessage('m2', '   ')).toBeUndefined()
    expect(cutToBytes('short', 100)).toBe('short')
    expect(plainWords('a\u0000b\tc\nd\u001b')).toBe('ab\tc\nd')
  })
})
