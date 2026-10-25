// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareCursorVersions, cursorEnvironment, cursorProgramOf, cursorPublishedVersion, findCursorProgram, newestCursorVersion, parseCursorVersion,
  writeCursorConfig, CURSOR_CLI_VERSION } from '../../../src/main/agents/cursorRpc'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const folder = async (): Promise<string> => { const path = await mkdtemp(join(tmpdir(), 'sotto-cursor-unit-')); folders.push(path); return path }

describe('Cursor versions', () => {
  it('reads both folder-name forms and nothing else', () => {
    expect(parseCursorVersion('2026.10.22-27dcf5f')).toEqual({ date: 20261022, time: 0, commit: '27dcf5f' })
    expect(parseCursorVersion('2026.1.5-11-02-03-abc123')).toEqual({ date: 20260105, time: 110203, commit: 'abc123' })
    for (const value of ['1.0.5', '2026.10.22', '2026.10.22-27dcf5f.new', '2026.10.22-27dcf5f.previous', 'latest']) expect(parseCursorVersion(value)).toBeUndefined()
  })
  it('orders by day, then by the time a newer build adds, never by commit', () => {
    expect(compareCursorVersions('2026.10.22-27dcf5f', '2026.10.23-0000000')).toBeLessThan(0)
    expect(compareCursorVersions('2026.11.1-aaaaaaa', '2026.10.30-bbbbbbb')).toBeGreaterThan(0)
    expect(compareCursorVersions('2026.10.22-01-00-00-ffffff', '2026.10.22-27dcf5f')).toBeGreaterThan(0)
    expect(compareCursorVersions('2026.10.22-09-00-00-aaaaaa', '2026.10.22-10-00-00-aaaaaa')).toBeLessThan(0)
    expect(compareCursorVersions('2026.10.22-27dcf5f', '2026.10.22-1234567')).toBe(0)
    // A version Sotto cannot read never passes the floor.
    expect(compareCursorVersions('unknown', CURSOR_CLI_VERSION)).toBeLessThan(0)
  })
  it('picks the newest version folder the way Cursor’s launcher does, passing staged and old trees over', async () => {
    const root = await folder()
    for (const name of ['2026.10.20-aaaaaaa', '2026.10.22-27dcf5f', '2026.10.22-01-02-03-bbbbbbb', '2026.10.30-ccccccc.new', '2026.10.29-ddddddd.previous', 'notes']) await mkdir(join(root, name))
    expect(await newestCursorVersion(root)).toBe('2026.10.22-01-02-03-bbbbbbb')
    expect(await newestCursorVersion(join(root, 'missing'))).toBeUndefined()
  })
  it('names the version Cursor’s install script downloads', () => {
    const script = 'TEMP="$HOME/.tmp"\nDOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.22-27dcf5f/${OS}/${ARCH}/agent-cli-package.tar.gz"\n'
    expect(cursorPublishedVersion(script)).toBe('2026.10.22-27dcf5f')
    expect(cursorPublishedVersion('DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.02-10-11-12-abc1234/linux/x64/agent.tar.gz"')).toBe('2026.11.02-10-11-12-abc1234')
    expect(cursorPublishedVersion('echo nothing here')).toBeUndefined()
  })
})

describe('Finding Cursor', () => {
  it('starts the newest version folder’s own node.exe with its index.js on Windows', async () => {
    const local = await folder()
    for (const version of ['2026.10.21-aaaaaaa', '2026.10.22-27dcf5f']) {
      const directory = join(local, 'cursor-agent', 'versions', version)
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'node.exe'), ''); await writeFile(join(directory, 'index.js'), '')
    }
    const program = await findCursorProgram({ LOCALAPPDATA: local }, { platform: 'win32' })
    const newest = join(local, 'cursor-agent', 'versions', '2026.10.22-27dcf5f')
    expect(program).toEqual({ executable: join(newest, 'node.exe'), args: [join(newest, 'index.js')] })
    expect(cursorProgramOf(join(newest, 'node.exe'))).toEqual(program)
    expect(cursorProgramOf('/home/me/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent')).toEqual({ executable: '/home/me/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent', args: [] })
  })
  it('finds nothing where Cursor is not installed', async () => {
    expect(await findCursorProgram({ LOCALAPPDATA: await folder() }, { platform: 'win32' })).toBeUndefined()
    expect(await findCursorProgram({}, { platform: 'win32' })).toBeUndefined()
  })
})

describe('Cursor’s environment', () => {
  it('passes the shared allow-list and Sotto’s Cursor folder, and no provider’s key', () => {
    const env = cursorEnvironment('/data/cursor/config', { PATH: '/bin', HOME: '/home/me', CURSOR_API_KEY: 'key', CURSOR_AUTH_TOKEN: 'token', OPENAI_API_KEY: 'other',
      ANTHROPIC_API_KEY: 'other', CURSOR_CONFIG_DIR: '/home/me/.cursor', XAI_API_KEY: 'other' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', CURSOR_CONFIG_DIR: '/data/cursor/config', CURSOR_INVOKED_AS: 'agent', NO_OPEN_BROWSER: '1' })
  })
})

describe('Sotto’s rules in its Cursor folder', () => {
  it('allows Sotto’s tool servers by name, denies nothing, and keeps what Cursor keeps there', async () => {
    const config = await folder()
    await writeFile(join(config, 'cli-config.json'), JSON.stringify({ version: 1, model: { modelId: 'gpt-5.4-nano' }, editor: { vimMode: true, theme: 'dark' },
      permissions: { allow: ['Shell(ls)'], deny: ['Read(.env)'] }, approvalMode: 'unrestricted' }))
    await writeCursorConfig(config, ['sotto_visual', 'sotto_browser', 'sotto_visual'])
    expect(JSON.parse(await readFile(join(config, 'cli-config.json'), 'utf8'))).toEqual({ version: 1, model: { modelId: 'gpt-5.4-nano' }, editor: { vimMode: false, theme: 'dark' },
      permissions: { allow: ['Mcp(sotto_browser:*)', 'Mcp(sotto_visual:*)'], deny: [] }, approvalMode: 'allowlist' })
  })
  it('writes the folder afresh when it has no file yet, or one it cannot read', async () => {
    const config = join(await folder(), 'nested', 'config')
    await writeCursorConfig(config, [])
    expect(JSON.parse(await readFile(join(config, 'cli-config.json'), 'utf8'))).toEqual({ version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] }, approvalMode: 'allowlist' })
    await writeFile(join(config, 'cli-config.json'), '{ not json')
    await writeCursorConfig(config, ['sotto_browser'])
    expect(JSON.parse(await readFile(join(config, 'cli-config.json'), 'utf8')).permissions).toEqual({ allow: ['Mcp(sotto_browser:*)'], deny: [] })
  })
})
