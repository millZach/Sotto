// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findPiExecutable, piProgram } from '../../../src/main/agents/piLookup'
import { piCatalog, piModels } from '../../../src/main/agents/piModels'
import { piEnvironment, PI_CLI_VERSION, comparePiVersions, PiRpc } from '../../../src/main/agents/piRpc'
import { piThreadEnvironment } from '../../../src/main/agents/piRuntime'
import { piEventUpdates } from '../../../src/main/agents/piEvents'
import type { OwnServer } from '../../../src/shared/ownModelServers'

const server: OwnServer = { id: 'own-test', name: 'Test', address: 'http://localhost:9000/v1', keyed: false,
  models: [{ id: 'model', name: 'Model', context: 131072, output: 4096, images: true, thinking: true }] }

it('offers only keyless servers and keeps the verified version as a floor', () => {
  expect(piCatalog([server, { ...server, id: 'own-keyed', keyed: true }]).map(model => model.id)).toEqual(['own-test/model'])
  expect(piCatalog([server])[0]).toMatchObject({ runtimeModes: ['full-access'], supportsImages: true, defaultReasoningEffort: 'medium' })
  expect(JSON.parse(piModels([server])).providers['own-test'].models[0]).toMatchObject({ contextWindow: 131072, maxTokens: 4096, input: ['text', 'image'] })
  expect(comparePiVersions('1.5.1', PI_CLI_VERSION)).toBeLessThan(0)
  expect(comparePiVersions('1.6.0', PI_CLI_VERSION)).toBeGreaterThan(0)
})

it('keeps unticked models for existing threads and marks them out of new model choices', () => {
  const choices = piCatalog([{ ...server, keptModelIds: ['kept'], models: [
    { ...server.models[0]!, id: 'kept' }, { ...server.models[0]!, id: 'old' },
  ] }])
  expect(choices).toMatchObject([
    { id: 'own-test/kept', ownServer: true },
    { id: 'own-test/old', ownServer: true, hiddenFromMenu: true },
  ])
  expect(choices[0]).not.toHaveProperty('hiddenFromMenu')
  expect(JSON.parse(piModels([{ ...server, keptModelIds: [] }])).providers['own-test'].models).toHaveLength(1)
})

it('isolates each thread’s configuration and keeps bearer tokens out of its files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-config-'))
  try {
    const first = await piThreadEnvironment(root, 'first', piModels([server]), [{ name: 'probe', type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: [{ name: 'Authorization', value: 'Bearer private-one' }] }])
    const second = await piThreadEnvironment(root, 'second', piModels([server]), [{ name: 'probe', type: 'http', url: 'http://127.0.0.1:4321/mcp', headers: [{ name: 'Authorization', value: 'Bearer private-two' }] }])
    expect(first.PI_CODING_AGENT_DIR).not.toBe(second.PI_CODING_AGENT_DIR)
    expect(first.SOTTO_PI_MCP_0_0).toBe('Bearer private-one')
    expect(second.SOTTO_PI_MCP_0_0).toBe('Bearer private-two')
    const config = await readFile(join(first.PI_CODING_AGENT_DIR!, 'mcp.json'), 'utf8')
    expect(config).toContain('${SOTTO_PI_MCP_0_0}')
    expect(config).not.toContain('private-one')
    expect(piEnvironment(root, {}, { OPENAI_API_KEY: 'secret', PI_CODING_AGENT_DIR: '/personal', PI_OFFLINE: '0', HOME: '/home/test' })).toEqual({ HOME: '/home/test', PI_CODING_AGENT_DIR: root, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('maps thinking and tool errors without treating agent_end as completion', () => {
  expect(piEventUpdates({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'A thought' } })).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A thought' } }])
  expect(piEventUpdates({ type: 'tool_execution_end', toolCallId: 't', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'Failed' }] } })[0]).toMatchObject({ toolCallId: 't', status: 'failed' })
  expect(piEventUpdates({ type: 'agent_end', willRetry: true })).toEqual([])
})

it('correlates out-of-order responses and drains stderr without parsing it', async () => {
  const code = `let input=''; const frames=[]; process.stderr.write('not protocol\\n'); process.stdin.on('data', c=>{input+=c;let n;while((n=input.indexOf('\\n'))>=0){frames.push(JSON.parse(input.slice(0,n)));input=input.slice(n+1);if(frames.length===2)for(const f of frames.reverse())process.stdout.write(JSON.stringify({type:'response',id:f.id,command:f.type,success:true,data:{value:f.value}})+'\\n')}});process.stdin.on('end',()=>process.exit(0));`
  const rpc = new PiRpc(process.execPath, ['-e', code], tmpdir(), process.env, 5000, () => {}, () => {})
  try {
    const received: number[] = []
    await Promise.all([rpc.request('first', { value: 1 }, value => { received.push((value as { value: number }).value) }), rpc.request('second', { value: 2 }, value => { received.push((value as { value: number }).value) })])
    expect(received).toEqual([2, 1])
  } finally { rpc.close(); await rpc.closed }
})


it('finds an npm Pi entry on Windows without invoking its batch wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-windows-'))
  try {
    const pkg = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'dist/cli.js' } }))
    const entry = join(pkg, 'dist', 'cli.js')
    await writeFile(entry, 'process.stdout.write("1.5.2")')
    expect(await findPiExecutable({ PATH: root }, { platform: 'win32', home: root, loginShellPath: async () => '' })).toBe(entry)
    const program = await piProgram(entry, process.env)
    expect(program.executable).not.toBe(entry)
    expect(program.args).toEqual([entry])
  } finally { await rm(root, { recursive: true, force: true }) }
})
