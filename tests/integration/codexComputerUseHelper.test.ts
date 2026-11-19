// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

// A Codex thread's Computer Use runs Codex's own helper, not the Codex app's pipe
// (docs/verification/2026-11-19-codex-computer-use-without-the-app.md).
const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup() })

const piped = { command: process.execPath, args: ['cua-repl.mjs'], enabled_tools: ['js'], env: { SKY_CUA_NATIVE_PIPE: '1', SKY_CUA_NATIVE_PIPE_DIRECTORY: '\\\\.\\pipe\\codex-computer-use-test' } }

async function started(script: Record<string, unknown>) {
  const fixture = await codexFixture()
  fixtures.push(fixture)
  await fixture.host.connect()
  await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
  await fixture.script(script)
  const folder = join(fixture.root, 'home', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1111.21308')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: piped } }))
  await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: fixture.projectId, modelId: fixture.modelId, title: 'Computer Use' })
  return (await fixture.driver.requests()).find(record => record.method === 'thread/start')!.params?.config as Record<string, unknown>
}

it.runIf(process.platform === 'win32')('starts a thread with the Codex app\'s pipe off for the configured and plugin Computer Use servers', async () => {
  const config = await started({ effectiveConfig: { mcp_servers: { node_repl: piped }, plugins: { 'unified-computer-use@openai-bundled': { enabled: true } } } })
  expect(config['mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE']).toBe('0')
  expect((config.mcp_servers as Record<string, unknown>).cua_repl).toEqual({ ...piped, env: { ...piped.env, SKY_CUA_NATIVE_PIPE: '0' } })
})

it('starts a thread as before when the Codex config does not use the app\'s pipe', async () => {
  const config = await started({ effectiveConfig: { mcp_servers: { node_repl: { ...piped, env: {} } } } })
  expect(Object.keys(config).filter(key => key.includes('SKY_CUA'))).toEqual([])
  expect((config.mcp_servers as Record<string, unknown> | undefined)?.cua_repl).toBeUndefined()
})

it('still starts a thread when Codex cannot read its config for Computer Use', async () => {
  const config = await started({ effectiveConfig: { mcp_servers: 'not a table' } })
  expect(config).toMatchObject({ 'features.default_mode_request_user_input': true })
})
