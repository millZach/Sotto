// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OPENCODE_SIGN_IN_KEY, OPENCODE_SOURCES_READ, SIGN_IN_WORDS, type ModelSources, type SignInResult, type SignInStart, type SignInWait } from '../../src/shared/opencodeSignIn'
import { registerOpenCodeSignInIpc } from '../../src/main/agents/opencodeSignInIpc'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'
import { ipcRegistry } from '../fixtures/ipcHarness'

// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-fixture-made-up-key-7d1e4b'

async function signInFixture(script: Record<string, unknown> = {}) {
  const opened: string[] = []
  const f = await opencodeFixture(undefined, undefined, {}, { openExternal: async url => { opened.push(url) }, signInIdleMs: 200 })
  await f.script(script)
  await f.host.connect()
  const requests = async (method: string) => (await f.driver.requests()).filter(record => record.method === method)
  const ok = (read: ModelSources): Extract<ModelSources, { status: 'ok' }> => { if (read.status !== 'ok') throw new Error(read.message); return read }
  return { f, opened, requests, ok, signIn: f.host.signIn }
}
const okResult = (result: SignInResult | SignInWait): ModelSources => { if (result.status !== 'ok') throw new Error(JSON.stringify(result)); return result.sources }
const waiting = (result: SignInStart) => { if (result.status !== 'waiting') throw new Error(result.message); return result.attempt }

it('lists every model source OpenCode knows, signed in to none, with Zen’s free models apart and no credential list read', async () => {
  const { f, ok, signIn, requests } = await signInFixture()
  try {
    const read = ok(await signIn.sources())
    expect(read.zenModels).toBe(2)
    expect(read.sources.map(source => source.id)).toEqual(['opencode', 'anthropic', 'openai', 'openrouter', 'github-copilot', 'google', 'xai', 'gitlab', 'zenmux'])
    expect(read.sources.every(source => !source.signedIn)).toBe(true)
    // OpenAI's legacy methods and every environment variable are left out.
    expect(read.sources.find(source => source.id === 'openai')!.methods.map(method => method.label)).toEqual(['API key', 'ChatGPT account'])
    expect(await requests('credential.list')).toEqual([])
  } finally { await f.cleanup() }
})

it('hands a key to Sotto’s OpenCode once, keeps no copy, reads the model list again and signs out again', async () => {
  const { f, signIn, requests, ok } = await signInFixture()
  try {
    const result = okResult(await signIn.signInWithKey({ sourceId: 'anthropic', key: `  ${KEY}  ` }))
    expect(ok(result).sources.find(source => source.id === 'anthropic')).toMatchObject({ signedIn: { how: 'API key' }, models: 2 })
    const sent = await requests('integration.connect.key')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).toMatchObject({ sessionID: 'anthropic', key: KEY })
    // The model menu has the new source's models, under OpenCode, and the tile's line says who is signed in.
    await expect.poll(async () => (await f.host.snapshot()).models.filter(model => model.source === 'Anthropic').map(model => model.id)).toEqual(['anthropic/claude-fixture', 'anthropic/claude-fixture-small'])
    expect((await f.host.snapshot()).account).toBe('Signed in to Anthropic')

    const out = okResult(await signIn.signOut({ sourceId: 'anthropic' }))
    expect(ok(out).sources.find(source => source.id === 'anthropic')!.signedIn).toBeUndefined()
    expect(await requests('credential.remove')).toHaveLength(1)
    await expect.poll(async () => (await f.host.snapshot()).models.some(model => model.source === 'Anthropic')).toBe(false)
    // Nothing Sotto keeps, shows or logs holds the key: not the answers, the snapshot, the event log or a saved file.
    const kept = JSON.stringify([result, out, await f.host.snapshot(), f.events]) + await readFile(join(f.root, 'opencode-threads.json'), 'utf8').catch(() => '')
    expect(kept).not.toContain(KEY)
    expect(f.events.every(event => /^opencode-(?:server|sign-in|sign-out)[a-z-]*$/u.test(event))).toBe(true)
    expect(f.events).toContain('opencode-sign-in-key')
    expect(f.events).toContain('opencode-sign-out')
  } finally { await f.cleanup() }
})

it('refuses a key OpenCode will not take, and an empty one without sending it, in words that say nothing was saved', async () => {
  const { f, signIn, requests } = await signInFixture()
  try {
    expect(await signIn.signInWithKey({ sourceId: 'anthropic', key: 'refuse-this-key' })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.keyRefused('Anthropic') })
    expect(SIGN_IN_WORDS.keyRefused('Anthropic')).toBe('OpenCode could not sign in to Anthropic with that key, so nothing was saved. Check the key in your Anthropic account and paste it again.')
    expect(await signIn.signInWithKey({ sourceId: 'anthropic', key: '   ' })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.keyRefused('Anthropic') })
    expect(await requests('integration.connect.key')).toHaveLength(1)
    expect(await signIn.signInWithKey({ sourceId: 'no-such-source', key: KEY })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.unknownSource })
  } finally { await f.cleanup() }
})

it('runs a device-code sign-in: opens the https page from main, shows the code, waits, and finishes by itself', async () => {
  const { f, signIn, opened, ok } = await signInFixture({ oauth: { 'xai:device': { mode: 'auto', code: 'QX7M-4LRT' } } })
  try {
    const attempt = waiting(await signIn.startBrowserSignIn({ sourceId: 'xai', methodId: 'device' }))
    expect(attempt).toMatchObject({ sourceId: 'xai', mode: 'auto', code: 'QX7M-4LRT', page: 'sign-in.fixture.invalid/xai/device' })
    expect(opened).toEqual(['https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT'])
    expect(await signIn.wait({ attemptId: attempt.id })).toEqual({ status: 'pending' })
    expect(await signIn.reopenPage({ attemptId: attempt.id })).toEqual({ status: 'ok' })
    expect(opened).toHaveLength(2)
    await writeFile(join(f.root, 'approve.json'), JSON.stringify({ integrationID: 'xai' }))
    const done = okResult(await signIn.wait({ attemptId: attempt.id }))
    expect(ok(done).sources.find(source => source.id === 'xai')).toMatchObject({ signedIn: { how: 'SuperGrok subscription' }, models: 1 })
    // The sign-in's tokens are OpenCode's: none reaches an answer, the snapshot or a log.
    expect(JSON.stringify([done, await f.host.snapshot(), f.events])).not.toMatch(/fixture-(?:refresh|access)-secret/u)
  } finally { await f.cleanup() }
})

it('runs a pasted-code sign-in, asks again for a code the page did not give, and asks the form’s question first', async () => {
  const { f, signIn, requests } = await signInFixture({ oauth: { 'gitlab:pkce': { mode: 'code' } } })
  try {
    const attempt = waiting(await signIn.startBrowserSignIn({ sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } }))
    expect(attempt).toMatchObject({ mode: 'code', page: 'sign-in.fixture.invalid/gitlab/authorize' })
    expect(attempt.code).toBeUndefined()
    expect(await signIn.finish({ attemptId: attempt.id, code: 'wrong' })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.codeRefused('GitLab Duo') })
    expect(okResult(await signIn.finish({ attemptId: attempt.id, code: 'good-code' })).status).toBe('ok')
    expect((await requests('integration.connect.oauth'))[0]!.params).toMatchObject({ methodID: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } })
    // GitHub Enterprise needs its address before the page opens; OpenCode refuses without it, and Sotto says what to do.
    expect(await signIn.startBrowserSignIn({ sourceId: 'github-copilot', methodId: 'device', answer: { deploymentType: 'enterprise' } }))
      .toEqual({ status: 'refused', message: SIGN_IN_WORDS.formRefused('GitHub Copilot') })
  } finally { await f.cleanup() }
})

it('says when a sign-in page expired, cancels one the user stops, and never opens a page that is not https', async () => {
  const { f, signIn, opened, requests } = await signInFixture({ oauthExpiresMs: 0 })
  try {
    const expired = waiting(await signIn.startBrowserSignIn({ sourceId: 'openai', methodId: 'chatgpt-token-sharing' }))
    expect(await signIn.wait({ attemptId: expired.id })).toEqual({ status: 'expired', message: SIGN_IN_WORDS.expired('OpenAI') })
    await f.script({})
    const stopped = waiting(await signIn.startBrowserSignIn({ sourceId: 'openai', methodId: 'chatgpt-token-sharing' }))
    expect(await signIn.cancel({ attemptId: stopped.id })).toEqual({ status: 'ok' })
    expect((await requests('integration.connect.oauth.cancel')).map(record => record.params?.itemID)).toContain(stopped.id)
    expect(await signIn.wait({ attemptId: stopped.id })).toMatchObject({ status: 'refused' })
    await f.script({ oauthUrl: 'http://sign-in.fixture.invalid/openai' })
    const before = opened.length
    expect(await signIn.startBrowserSignIn({ sourceId: 'openai', methodId: 'chatgpt-token-sharing' })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.unsafePage })
    expect(opened).toHaveLength(before)
  } finally { await f.cleanup() }
})

it('signs in to nothing while OpenCode is not connected, and stops its server once nothing uses it', async () => {
  const { f, signIn, requests } = await signInFixture()
  try {
    expect((await signIn.sources()).status).toBe('ok')
    const started = (await requests('fixture/process')).length
    // The server stops after its idle time, and the next read starts another.
    await expect.poll(async () => { await signIn.sources(); return (await requests('fixture/process')).length }, { interval: 400 }).toBeGreaterThan(started)
    f.host.disconnect(); await f.host.closed()
    expect(await signIn.sources()).toEqual({ status: 'refused', message: SIGN_IN_WORDS.notRunning })
    expect(await signIn.signInWithKey({ sourceId: 'anthropic', key: KEY })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.notRunning })
  } finally { await f.cleanup() }
})

it('carries a key from the window to OpenCode and back through the bridge without the key or a credential in any answer', async () => {
  const { f, signIn } = await signInFixture()
  const { ipc, main, invoke } = ipcRegistry()
  const close = registerOpenCodeSignInIpc(ipc, signIn, () => [main])
  try {
    const answer = await invoke(OPENCODE_SIGN_IN_KEY, [{ sourceId: 'anthropic', key: KEY }])
    expect(answer).toMatchObject({ status: 'ok' })
    // Sotto's OpenCode now holds the key, and OpenCode answers its credential list with it; none of that crosses.
    expect(await readFile(join(f.root, 'credentials.json'), 'utf8')).toContain(KEY)
    const read = await invoke(OPENCODE_SOURCES_READ, [])
    expect(JSON.stringify([answer, read])).not.toContain(KEY)
    expect(JSON.stringify([answer, read])).not.toContain('cred_')
    // A request the bridge cannot read answers that OpenCode is not running, and echoes nothing it was sent.
    expect(await invoke(OPENCODE_SIGN_IN_KEY, [{ sourceId: 'anthropic', key: KEY, extra: true }])).toEqual({ status: 'refused', message: SIGN_IN_WORDS.notRunning })
    expect(JSON.stringify(f.events)).not.toContain(KEY)
  } finally { close(); await f.cleanup() }
})

it('names the signed-in source when it refuses a turn, since OpenCode keeps a key without trying it', async () => {
  const { f, signIn } = await signInFixture()
  try {
    // OpenCode 2.0.31 takes any key at sign-in (the scratch probe sent none to its source), so a wrong key shows on the first turn.
    okResult(await signIn.signInWithKey({ sourceId: 'anthropic', key: KEY }))
    await expect.poll(async () => (await f.host.snapshot()).models.some(model => model.id === 'anthropic/claude-fixture')).toBe(true)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: 'anthropic/claude-fixture', title: 'Anthropic thread' })
    f.host.observeThreads?.([id])
    expect(await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })).toEqual({ accepted: true })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('running')
    await f.action(id, { type: 'fail' })
    await expect.poll(async () => JSON.stringify((await f.host.snapshot()).threads.find(thread => thread.id === id)))
      .toContain('Anthropic refused the sign-in Sotto’s OpenCode has for it, so this turn did not run. Nothing else was lost.')
  } finally { await f.cleanup() }
})
