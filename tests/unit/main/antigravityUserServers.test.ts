// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antigravityUserMcpConfig, readAntigravityUserServers } from '../../../src/main/agents/antigravityUserServers'

describe('the user’s own agy MCP servers', () => {
  let folder = '', config = ''
  beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'sotto-agy-user-mcp-')); config = join(folder, 'mcp_config.json') })
  afterEach(async () => { await rm(folder, { recursive: true, force: true }) })
  const read = async (text: string, httpServers = true) => { await writeFile(config, text); return readAntigravityUserServers(config, httpServers) }

  it('is agy’s own global file under the home folder', () => {
    expect(antigravityUserMcpConfig(join('home', 'someone'))).toBe(join('home', 'someone', '.gemini', 'config', 'mcp_config.json'))
  })

  it('is none when the file is missing, empty, not JSON or not agy’s shape', async () => {
    expect(await readAntigravityUserServers(join(folder, 'missing.json'), true)).toEqual([])
    expect(await read('')).toEqual([])
    expect(await read('{ not json')).toEqual([])
    expect(await read('{"mcpServers": []}')).toEqual([])
    expect(await read('{}')).toEqual([])
  })

  it('takes local and Streamable HTTP servers in agy’s schema, in the file’s order, and leaves out only the entries agy could not run', async () => {
    expect(await read(JSON.stringify({ mcpServers: {
      local: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret' } },
      bare: { command: 'bare-mcp' },
      remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret' } },
      older: { serverUrl: 'http://127.0.0.1:7000/mcp' },
      off: { command: 'off-mcp', disabled: true },
      nothing: {},
      file: { url: 'file:///etc/passwd' },
      bare_scheme: { url: 'https://' },
      wrong: { command: 7 },
    } }))).toEqual([
      { name: 'local', command: 'node', args: ['server.js'], env: [{ name: 'TOKEN', value: 'secret' }] },
      { name: 'bare', command: 'bare-mcp', args: [], env: [] },
      { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer secret' }] },
      { name: 'older', type: 'http', url: 'http://127.0.0.1:7000/mcp', headers: [] },
    ])
  })

  it('leaves out a server that needs a setting ACP cannot carry, rather than run it otherwise than set up', async () => {
    expect(await read(JSON.stringify({ mcpServers: {
      hidden: { command: 'a', disabledTools: ['delete_everything'] },
      allowlist: { command: 'b', enabledTools: ['read'] },
      folder: { command: 'c', cwd: '/srv/mcp' },
      signin: { url: 'https://mcp.example.com/mcp', oauth: { clientId: 'id' } },
      google: { url: 'https://mcp.example.com/mcp', authProviderType: 'google_credentials' },
      tuned: { command: 'd', disabledTools: [], tools: { read: { eager: true } }, timeoutSeconds: 30 },
    } }))).toEqual([{ name: 'tuned', command: 'd', args: [], env: [] }])
  })

  it('hands only local servers to an agy that refuses HTTP ones', async () => {
    expect(await read(JSON.stringify({ mcpServers: { local: { command: 'node' }, remote: { url: 'https://mcp.example.com/mcp' } } }), false))
      .toEqual([{ name: 'local', command: 'node', args: [], env: [] }])
  })
})
