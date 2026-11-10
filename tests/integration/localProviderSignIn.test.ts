// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalProviderSignIn, withoutOwnBrowser } from '../../src/main/agents/localProviderSignIn'
import type { LocalSignInProvider } from '../../src/shared/localProviderSignIn'
import { fakeSignInCommand } from '../fixtures/signInProviders'

/**
 * A provider's sign-in on this computer, from its row in Settings › Providers (ADR-0200): the sign-in a host runs for
 * a paired client (ADR-0037), on this computer's own (fake) client, answered to the window without the page's address.
 */
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-local-sign-in-')) })
afterEach(async () => { if (root && dirname(root) === tmpdir() && root.includes('sotto-local-sign-in-')) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('signing a provider in on this computer', () => {
  let signIn: LocalProviderSignIn | undefined
  afterEach(() => { signIn?.close(); signIn = undefined })
  const make = (options: { page?: string; installed?: boolean; connect?: (provider: LocalSignInProvider) => Promise<string | undefined>; open?: (url: string) => Promise<void> } = {}) => {
    const opened: string[] = [], connected: LocalSignInProvider[] = []
    signIn = new LocalProviderSignIn({
      command: options.installed === false ? async () => undefined : fakeSignInCommand(root, undefined, options.page),
      connect: options.connect ?? (async provider => { connected.push(provider); return undefined }),
      openExternal: options.open ?? (async url => { opened.push(url) }),
    })
    return { signIn, opened, connected }
  }

  it('shows Codex’s code without the page’s address, opens the page on a press, and connects Codex once the code is entered', async () => {
    const { signIn, opened, connected } = make()
    const started = await signIn.request({ type: 'start', provider: 'codex' })
    expect(started).toMatchObject({ provider: 'codex', shape: 'device-code', stage: 'waiting', page: 'auth.openai.com', code: 'WDJB-MJHTQ' })
    // The window is told where the sign-in stands and never where it points; nothing opens until Open sign-in page.
    expect(JSON.stringify(started)).not.toContain('https://')
    expect(opened).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'codex.args.json'), 'utf8'))).toEqual(['login', '--device-auth'])
    const afterOpen = await signIn.request({ type: 'open', signInId: started!.id })
    expect(opened).toEqual(['https://auth.openai.com/codex/device'])
    expect(JSON.stringify(afterOpen)).not.toContain('https://')
    await writeFile(join(root, 'codex.approved'), '')
    await expect.poll(async () => (await signIn.request({ type: 'read', signInId: started!.id }))?.stage).toBe('connected')
    expect(connected).toEqual(['codex'])
  })

  it('hands Claude Code the code pasted back from its page, and connects it', async () => {
    const { signIn, connected } = make()
    const started = await signIn.request({ type: 'start', provider: 'claude' })
    expect(started).toMatchObject({ shape: 'paste-code', stage: 'waiting', page: 'claude.com' })
    await expect(signIn.request({ type: 'code', signInId: started!.id, code: 'good-code' })).rejects.toThrow('That is not the whole code.')
    expect((await signIn.request({ type: 'code', signInId: started!.id, code: 'good-code#fixture-state' }))?.stage).toBe('finishing')
    await expect.poll(async () => (await signIn.request({ type: 'read', signInId: started!.id }))?.stage).toBe('connected')
    expect(connected).toEqual(['claude'])
  })

  it('says what the provider said when it signed in but did not connect', async () => {
    const { signIn } = make({ connect: async () => 'Grok Build is too old to use.' })
    const started = await signIn.request({ type: 'start', provider: 'grok' })
    await writeFile(join(root, 'grok.approved'), '')
    await expect.poll(async () => (await signIn.request({ type: 'read', signInId: started!.id }))?.stage).toBe('failed')
    expect((await signIn.request({ type: 'read', signInId: started!.id }))?.message).toBe('Grok Build signed in, but did not connect: Grok Build is too old to use.')
  })

  it('stops a sign-in that is cancelled, and opens nothing for one that has ended', async () => {
    const { signIn, opened } = make()
    const started = await signIn.request({ type: 'start', provider: 'grok' })
    expect(await signIn.request({ type: 'cancel', signInId: started!.id })).toBeNull()
    expect((await signIn.request({ type: 'read', signInId: started!.id }))?.stage).toBe('ended')
    await expect(signIn.request({ type: 'open', signInId: started!.id })).rejects.toThrow('This sign-in is no longer waiting for you. Nothing was opened. Start it again.')
    expect(opened).toEqual([])
  })

  it('opens no page that is not the provider’s own, and names this computer rather than a host', async () => {
    const elsewhere = make({ page: 'https://login.example.com/device' })
    expect(await elsewhere.signIn.request({ type: 'start', provider: 'codex' })).toMatchObject({ stage: 'failed',
      message: 'Codex asked to sign in on a page Sotto does not open. Nothing was signed in. Sign in to Codex in a terminal instead.' })
    expect(elsewhere.opened).toEqual([])
    elsewhere.signIn.close()
    const missing = make({ installed: false })
    await expect(missing.signIn.request({ type: 'start', provider: 'claude' })).rejects.toThrow('Claude Code is not installed on this computer, so it cannot sign in. Nothing was changed.')
  })

  it('gives Claude Code a browser that does nothing on Linux and macOS, so its page opens only on the press', () => {
    const command = { executable: '/usr/bin/claude', args: ['auth', 'login', '--claudeai'], env: { PATH: '/usr/bin', NO_COLOR: '1' } }
    expect(withoutOwnBrowser('claude', command, 'linux')?.env).toEqual({ PATH: '/usr/bin', NO_COLOR: '1', BROWSER: expect.stringMatching(/^\/(?:usr\/)?bin\/true$/u) })
    expect(withoutOwnBrowser('claude', command, 'darwin')?.env.BROWSER).toBeDefined()
    // Codex's and Grok Build's device-code sign-ins open nothing by themselves; Windows is not measured, so it is left alone.
    expect(withoutOwnBrowser('codex', command, 'linux')).toBe(command)
    expect(withoutOwnBrowser('grok', command, 'linux')).toBe(command)
    expect(withoutOwnBrowser('claude', command, 'win32')).toBe(command)
    expect(withoutOwnBrowser('claude', undefined, 'linux')).toBeUndefined()
  })

  it('says the page could not open when the browser did not take it, and keeps the sign-in waiting', async () => {
    const { signIn } = make({ open: async () => { throw new Error('no browser') } })
    const started = await signIn.request({ type: 'start', provider: 'codex' })
    await expect(signIn.request({ type: 'open', signInId: started!.id })).rejects.toThrow('The sign-in page could not open in your browser. Nothing was changed. Try Open sign-in page again.')
    expect((await signIn.request({ type: 'read', signInId: started!.id }))?.stage).toBe('waiting')
  })
})
