// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GrokSubscriptionClient } from '../../../src/main/agents/subscriptionGrok'

const roots: string[] = []
const catalog = { currentModelId: 'grok-native-new', availableModels: [
  { modelId: 'grok-native-new', name: 'Native new model', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high', default: true }, { id: 'xhigh', value: 'xhigh' }] } },
  { modelId: 'grok-native-fast', name: 'Native fast model' },
] }
interface Scenario { auth?: boolean; mode?: 'invalid' | 'timeout' | 'large' | 'permission' | 'tool'; models?: unknown; wrongEffort?: boolean; wrongModel?: boolean }
interface Call { pid: number; method: string; params: Record<string, unknown>; args: string[]; env: Record<string, string>; cwd: string; policy: string }
async function fixture(scenario: Scenario = {}, timeoutMs = 3_000) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-grok-route-'))
  roots.push(root)
  const script = join(root, 'native.cjs'), scenarioPath = join(root, 'scenario.json'), log = join(root, 'calls.jsonl')
  const configure = (value: Scenario) => writeFile(scenarioPath, JSON.stringify({ auth: true, models: catalog, ...value }))
  await configure(scenario)
  await writeFile(script, `
const fs = require('node:fs'), rl = require('node:readline');
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
rl.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,method:request.method,params:request.params,args:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(GROK_|XAI_|NODE_OPTIONS)/i.test(k))),cwd:process.cwd(),policy:fs.readFileSync(require('node:path').join(process.env.GROK_HOME,'requirements.toml'),'utf8')})+'\\n');
 if(request.method==='initialize') return reply(request.id,{protocolVersion:1,authMethods:[{id:'cached_token'},{id:'grok.com'}]});
 if(request.method==='authenticate') return scenario.auth ? reply(request.id,{}) : process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'fixture-private-auth-error'}})+'\\n');
 if(request.method==='session/new') {
  const args=process.argv.slice(2), selected=args.includes('--model')?args[args.indexOf('--model')+1]:scenario.models.currentModelId;
  return reply(request.id,{sessionId:'native-session',models:{...scenario.models,currentModelId:scenario.wrongModel?scenario.models.currentModelId:selected},_meta:{'x.ai/sessionConfig':{options:[{id:scenario.wrongEffort?'high':args[args.indexOf('--reasoning-effort')+1],category:'mode',selected:true}]}}});
 }
 if(request.method==='session/set_model') {
  const selected=scenario.wrongModel?'grok-native-new':request.params.modelId;
  reply(request.id,{_meta:{model:{Ok:selected}}});
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId:'native-session',update:{sessionUpdate:'model_changed',model_id:selected,reasoning_effort:scenario.wrongEffort?'high':request.params._meta?.reasoningEffort??'high'}}})+'\\n');
  return;
 }
 if(request.method==='session/prompt') {
  if(scenario.mode==='timeout') return;
  if(scenario.mode==='large') return process.stderr.write('x'.repeat(50000));
  if(scenario.mode==='permission') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{sessionId:'native-session',options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}})+'\\n'); return; }
  if(scenario.mode==='tool') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'tool_call',kind:'execute'}}})+'\\n'); return; }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:scenario.mode==='invalid'?'private-invalid-result':JSON.stringify({type:'clarify',text:'Which project?'})}}}})+'\\n');
  return reply(request.id,{stopReason:'end_turn'});
 }
});
`)
  const nativeHome = join(root, 'user-native-home')
  const environment = { ...process.env, GROK_HOME: nativeHome, XAI_API_KEY: 'fixture-key', GROK_CONFIG: 'fixture-routing', GROK_AUTH: 'fixture-auth', GROK_XAI_API_BASE_URL: 'https://wrong.example', NODE_OPTIONS: '--fixture' }
  const client = new GrokSubscriptionClient(join(root, 'isolated'), { executable: process.execPath, prefixArgs: [script], environment, completionTimeoutMs: timeoutMs, statusTimeoutMs: timeoutMs, outputLimitBytes: 40_000 })
  return { root, nativeHome, client, configure, async calls(): Promise<Call[]> { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) } }
}
afterEach(async () => { for (const root of roots.splice(0)) { if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-grok-route-')) throw new Error('Unexpected temporary Grok directory'); await rm(root, { recursive: true, force: true }) } })
describe('Grok reasoning shutdown', () => {
  it('cancels a running native prompt, reaps its process and removes its temporary home', async () => {
    const f = await fixture({ mode: 'timeout' }, 180_000)
    const shutdown = new AbortController()
    const result = f.client.complete('Return JSON.', { text: 'Synthetic shutdown prompt' }, '', undefined, shutdown.signal)
    const rejected = expect(result).rejects.toThrow('Sotto reasoning stopped.')
    try {
      let pid = 0
      await expect.poll(async () => {
        const calls = await f.calls().catch(() => [])
        pid = calls.find(call => call.method === 'session/prompt')?.pid ?? 0
        return pid > 0
      }).toBe(true)
      shutdown.abort()
      await rejected
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await readdir(join(f.root, 'isolated'))).toEqual([])
      const count = (await f.calls()).length
      await expect(f.client.complete('Return JSON.', {}, '', undefined, shutdown.signal)).rejects.toThrow()
      expect(await f.calls()).toHaveLength(count)
    } finally { shutdown.abort(); await result.catch(() => undefined) }
  })
})

describe('Grok native subscription client', () => {
  it('discovers native models and effort using only cached authentication and no inference', async () => {
    const f = await fixture()
    expect(await f.client.status()).toMatchObject({ provider: 'grok', installed: true, ready: true, defaultModelId: 'grok-native-new', allowCustomModel: false, models: [{ id: 'grok-native-new', name: 'Native new model', reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high' }, { id: 'grok-native-fast', name: 'Native fast model', reasoningEfforts: [] }] })
    const calls = await f.calls()
    expect(calls.map(call => call.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(calls[1]!.params).toEqual({ methodId: 'cached_token', _meta: { headless: true } })
    expect(calls[0]!.env.GROK_AUTH_PATH).toBe(join(f.nativeHome, 'auth.json'))
    expect(calls[0]!.env.GROK_HOME).not.toBe(f.nativeHome)
    expect(calls[0]!.env).toMatchObject({ GROK_DISABLE_API_KEY_AUTH: '1', GROK_DISABLE_AUTOUPDATER: '1' })
    for (const key of ['XAI_API_KEY', 'GROK_AUTH', 'NODE_OPTIONS']) expect(calls[0]!.env).not.toHaveProperty(key)
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--tools', '', '--no-subagents', '--disable-web-search', '--no-leader']))
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--deny', '*']))
    expect(calls.every(call => call.policy === '[permission]\nrules = [{ action = "deny", tool = "any" }]\n')).toBe(true)
  })
  it('uses the discovered native default without requiring an API key or manually entered model', async () => {
    const f = await fixture()
    expect(await f.client.complete('Return JSON only.', { text: 'Private prompt $(never-a-shell)' }, '')).toEqual({ type: 'clarify', text: 'Which project?' })
    const calls = await f.calls()
    expect(calls.filter(call => call.method === 'session/prompt')).toHaveLength(1)
    expect(calls.every(call => !call.args.join(' ').includes('Private prompt'))).toBe(true)
    expect(await readdir(join(f.root, 'isolated'))).toEqual([])
  })

  it('applies the selected model and effort together and checks native acknowledgement', async () => {
    const f = await fixture()
    await f.client.complete('JSON only', {}, 'grok-native-new', 'xhigh')
    const calls = await f.calls()
    expect(calls.find(call => call.method === 'session/set_model')?.params).toEqual({ sessionId: 'native-session', modelId: 'grok-native-new', _meta: { reasoningEffort: 'xhigh' } })
    await f.configure({ wrongEffort: true })
    await expect(f.client.complete('JSON only', {}, 'grok-native-new', 'low')).rejects.toThrow(/did not confirm.*effort/u)
    expect((await f.calls()).filter(call => call.method === 'session/prompt')).toHaveLength(1)
  })

  it('does not send a prompt when the selected model or effort is not available', async () => {
    const f = await fixture()
    await expect(f.client.complete('JSON only', {}, 'unknown-model')).rejects.toThrow(/current model|catalog/u)
    await expect(f.client.complete('JSON only', {}, 'grok-native-fast', 'low')).rejects.toThrow(/does not report.*effort/u)
    await f.configure({ wrongModel: true })
    await expect(f.client.complete('JSON only', {}, 'grok-native-fast')).rejects.toThrow(/did not select.*model/u)
    expect((await f.calls()).some(call => call.method === 'session/prompt')).toBe(false)
  })

  it('rechecks native cached authentication and never falls back after sign-out', async () => {
    const f = await fixture({ auth: false })
    const account = await f.client.status()
    expect(account).toMatchObject({ installed: true, ready: false, models: [] })
    expect(JSON.stringify(account)).not.toContain('fixture-private')
    await expect(f.client.complete('JSON only', {}, '')).rejects.toThrow(/will not switch to API billing/u)
    expect((await f.calls()).some(call => call.method === 'session/new' || call.method === 'session/prompt')).toBe(false)
  })

  it.each(['permission', 'tool'] as const)('rejects %s requests and cleans the isolated session', async mode => {
    const f = await fixture({ mode })
    await expect(f.client.complete('JSON only', {}, '')).rejects.toThrow(/action.*denied|tool call/u)
    expect(await readdir(join(f.root, 'isolated'))).toEqual([])
  })

  it.each(['invalid', 'large', 'timeout'] as const)('bounds %s responses without exposing native output', async mode => {
    const f = await fixture({ mode }, mode === 'timeout' ? 250 : 3_000)
    await expect(f.client.complete('JSON only', {}, '')).rejects.toThrow(/valid JSON|size limit|timed out/u)
    expect(await readdir(join(f.root, 'isolated'))).toEqual([])
  })
})
