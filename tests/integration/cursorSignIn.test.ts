// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CursorSignIn } from '../../src/main/agents/cursorSignIn'
import { CURSOR_SIGN_IN_WORDS } from '../../src/shared/cursorSignIn'
import { parseProviderRecords } from '../fixtures/providerRecords'
import { fakeCursorProgram } from '../fixtures/fakeCursorFixture'

describe('Cursor’s sign-in from its tile (ADR-0128)', () => {
  let root: string | undefined
  let signIn: CursorSignIn | undefined
  afterEach(async () => { signIn?.close(); signIn = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined })
  const make = async (connect: () => Promise<string | undefined> = async () => undefined) => {
    root = await mkdtemp(join(tmpdir(), 'sotto-cursor-sign-in-'))
    const folder = root
    const opened: string[] = []
    let signedOut = 0
    signIn = new CursorSignIn({ configDirectory: join(folder, 'config'), program: async () => fakeCursorProgram(folder), connect,
      signedOut: async () => { signedOut++ }, openExternal: async url => { opened.push(url) } })
    return { folder, opened, signedOut: () => signedOut, signIn }
  }
  const commands = async (folder: string) => parseProviderRecords<{ command: string; env?: Record<string, string | undefined> }>(await readFile(join(folder, 'commands.jsonl'), 'utf8').catch(() => ''))

  it('runs agent login with no browser of its own, opens its cursor.com page, and connects once Cursor says it signed in', async () => {
    let connected = 0
    const { folder, opened, signIn } = await make(async () => { connected++; return undefined })
    const started = await signIn.start()
    expect(started.view).toMatchObject({ provider: 'cursor', shape: 'page', stage: 'waiting', page: 'cursor.com' })
    // The window is never given the page's address; main opened it.
    expect(JSON.stringify(started)).not.toContain('loginDeepControl')
    expect(opened).toEqual(['https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login'])
    expect(await commands(folder)).toEqual([{ command: 'login', env: { NO_OPEN_BROWSER: '1', CURSOR_CONFIG_DIR: join(folder, 'config') } }])
    expect(await signIn.reopen(started.view!.id)).toEqual({ ok: true })
    expect(opened).toHaveLength(2)
    await writeFile(join(folder, 'login-done'), '')
    await expect.poll(async () => (await signIn.read(started.view!.id))?.stage).toBe('connected')
    expect(connected).toBe(1)
  })

  it('opens no page that is not Cursor’s, and signs nothing in', async () => {
    const { folder, opened, signIn } = await make()
    await writeFile(join(folder, 'login.json'), JSON.stringify({ page: 'https://cursor.example.com/login' }))
    const started = await signIn.start()
    expect(started.view?.stage).toBe('failed')
    expect(opened).toEqual([])
  })

  it('stops a sign-in the user cancels', async () => {
    const { signIn } = await make()
    const started = await signIn.start()
    expect(await signIn.cancel(started.view!.id)).toEqual({ ok: true })
    expect((await signIn.read(started.view!.id))?.stage).toBe('ended')
  })

  it('signs out with agent logout in Sotto’s Cursor folder, then disconnects Cursor', async () => {
    const made = await make()
    expect(await made.signIn.signOut()).toEqual({ ok: true, message: CURSOR_SIGN_IN_WORDS.signedOut })
    expect((await commands(made.folder)).map(entry => entry.command)).toEqual(['logout'])
    expect(made.signedOut()).toBe(1)
  })
})
