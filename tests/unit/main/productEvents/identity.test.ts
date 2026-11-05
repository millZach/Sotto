// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteInstallId, ensureInstallId, hashProductEventId, openAiUserId, productEventHomes, PRODUCT_EVENTS_INSTALL_FILE, readProductEventOwners } from '../../../../src/main/productEvents/identity'

const ACCOUNT = '2f1c7a64-90de-4c11-8a35-1b2c3d4e5f60'
const REFRESH = 'rt_refresh-token-that-must-never-leave'
const jwt = (claims: unknown): string => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const authFile = (userId: string): string => JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ sub: 'google-oauth2|1', 'https://api.openai.com/auth': { user_id: userId, chatgpt_account_id: 'workspace-shared' } }), access_token: 'at', refresh_token: REFRESH, account_id: 'workspace-shared' } })

describe('product event identity', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-product-events-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('hashes with a prefix of its own, so it matches no plain hash of the same ID', () => {
    const hash = hashProductEventId(ACCOUNT)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(createHash('sha256').update(ACCOUNT).digest('hex'))
  })

  it('makes one install ID, keeps it, and leaves nothing after deleting', async () => {
    const first = await ensureInstallId(directory)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await ensureInstallId(directory)).toBe(first)
    const path = join(directory, PRODUCT_EVENTS_INSTALL_FILE)
    expect(await readFile(path, 'utf8')).not.toBe(first)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await deleteInstallId(directory)
    await expect(stat(path)).rejects.toThrow()
    expect(await ensureInstallId(directory)).not.toBe(first)
  })

  it('answers null rather than throwing when the folder cannot be written', async () => {
    const file = join(directory, 'a-file')
    await writeFile(file, 'x')
    expect(await ensureInstallId(join(file, 'below'))).toBeNull()
  })

  it('reads only the user_id claim from Codex, never the workspace or a token', () => {
    expect(openAiUserId(authFile('user-abc'))).toBe('user-abc')
    expect(openAiUserId(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }))).toBeNull()
    expect(openAiUserId(JSON.stringify({ tokens: { id_token: 'not.a-jwt.at-all' } }))).toBeNull()
    expect(openAiUserId('not json')).toBeNull()
  })

  it('hashes both accounts and nothing else, reading the folders the clients use', async () => {
    const codexHome = join(directory, 'codex'), claudeHome = join(directory, 'claude')
    await mkdir(codexHome); await mkdir(claudeHome)
    await writeFile(join(codexHome, 'auth.json'), authFile('user-abc'))
    await writeFile(join(claudeHome, '.claude.json'), JSON.stringify({ userID: 'per-machine', oauthAccount: { accountUuid: ACCOUNT, emailAddress: 'someone@example.com' } }))
    const homes = productEventHomes({ CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome }, '/nowhere')
    const owners = await readProductEventOwners(homes)
    expect(owners).toEqual([{ ownerSource: 'claude', ownerId: hashProductEventId(ACCOUNT) }, { ownerSource: 'openai', ownerId: hashProductEventId('user-abc') }])
    const said = JSON.stringify(owners)
    for (const secret of [REFRESH, 'someone@example.com', ACCOUNT, 'user-abc', 'workspace-shared', 'per-machine']) expect(said).not.toContain(secret)
  })

  it('finds the Claude account across a piece boundary in a large file', async () => {
    const path = join(directory, '.claude.json')
    const pad = 64 * 1024 - 20
    await writeFile(path, `{"projects":"${'x'.repeat(pad)}","oauthAccount":{"accountUuid":"${ACCOUNT}"}}`)
    const owners = await readProductEventOwners({ claudeFile: path, codexHome: join(directory, 'none') })
    expect(owners).toEqual([{ ownerSource: 'claude', ownerId: hashProductEventId(ACCOUNT) }])
  })

  it('leaves out an account whose file is missing or too large', async () => {
    expect(await readProductEventOwners({ claudeFile: join(directory, 'none'), codexHome: join(directory, 'none') })).toEqual([])
    const codexHome = join(directory, 'big')
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'auth.json'), `${authFile('user-abc')}${' '.repeat(300 * 1024)}`)
    expect(await readProductEventOwners({ claudeFile: join(directory, 'none'), codexHome })).toEqual([])
  })
})
