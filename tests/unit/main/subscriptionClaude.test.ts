// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSubscriptionClient } from '../../../src/main/agents/subscriptionClaude'

const roots: string[] = []
const flags = '--safe-mode --tools --permission-prompts --no-session-persistence --input-format --output-format --system-prompt --model --effort --verbose'
const nativeModels = [
  { value: 'haiku', displayName: 'Native quick model' },
  { value: 'default', displayName: 'Native account default', resolvedModel: 'claude-next-default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'claude-future[1m]', displayName: 'New extended model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Native Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
]
interface Scenario {
  auth?: { loggedIn: boolean; authMethod?: string; subscriptionType?: string; email?: string }
  help?: string
  result?: unknown
  models?: unknown
  discovery?: 'mismatch' | 'error'
  mode?: 'exit' | 'invalid' | 'timeout' | 'large-out' | 'large-err'
}
interface Invocation { args: string[]; input: string; pid: number; overrides: string[] }

async function fixture(scenario: Scenario = {}, options: { completionTimeoutMs?: number; outputLimitBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-client-'))
  roots.push(root)
  const scenarioPath = join(root, 'scenario.json')
  const logPath = join(root, 'calls.jsonl')
  const script = join(root, 'claude-fixture.cjs')
  const configure = async (value: Scenario): Promise<void> => {
    await writeFile(scenarioPath, JSON.stringify({ auth: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'private-fixture@example.test' }, help: flags, models: nativeModels, ...value }))
  }
  await configure(scenario)
  // This replaces only the external executable. Real spawn, pipes, deadlines,
  // output bounds, environment filtering, and JSON parsing remain under test.
  await writeFile(script, `
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
const args = process.argv.slice(2);
function record(input) {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, input, pid: process.pid,
    overrides: Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$|XAI_API_KEY$)/i.test(k))}) + '\\n');
}
if (args.includes('--help')) { record(''); process.stdout.write(scenario.help); }
else if (args.includes('status')) { record(''); process.stdout.write(JSON.stringify(scenario.auth)); }
else {
  let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    record(input);
    if (args.includes('--input-format')) {
      const request = JSON.parse(input.trim());
      process.stdout.write(JSON.stringify({type:'control_response', response:{subtype:scenario.discovery==='error'?'error':'success', request_id:scenario.discovery==='mismatch'?'other-request':request.request_id,
        response:{models:scenario.models, account:{email:'private-fixture@example.test'}}}}) + '\\n');
      return;
    }
    if (scenario.mode === 'timeout') { setInterval(() => {}, 1000); return; }
    if (scenario.mode === 'exit') { process.stderr.write('fixture-secret-error'); process.stdout.write('fixture-secret-error'); process.exitCode = 7; return; }
    if (scenario.mode === 'large-out') { process.stdout.write('x'.repeat(20000)); return; }
    if (scenario.mode === 'large-err') { process.stderr.write('x'.repeat(20000)); return; }
    if (scenario.mode === 'invalid') { process.stdout.write('fixture-secret-invalid-json'); return; }
    process.stdout.write(JSON.stringify(scenario.result ?? {type:'result', is_error:false, result:JSON.stringify({type:'clarify',text:'Which project?'})}));
  });
}
`)
  const environment = { ...process.env, ANTHROPIC_API_KEY: 'fixture-other-account-key', ANTHROPIC_BASE_URL: 'https://wrong-origin.example',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'fixture-other-login', XAI_API_KEY: 'fixture-unrelated-secret' }
  const client = new ClaudeSubscriptionClient(join(root, 'reasoning'), { executable: process.execPath, prefixArgs: [script], environment, ...options })
  return { root, client, configure, environment, async calls(): Promise<Invocation[]> {
    return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Invocation)
  } }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-client-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Claude reasoning shutdown', () => {
  it('cancels a running native decision and waits for its process to close', async () => {
    const f = await fixture({ mode: 'timeout' })
    const shutdown = new AbortController()
    const result = f.client.complete('Return JSON.', { text: 'Synthetic shutdown prompt' }, 'sonnet', undefined, shutdown.signal)
    const rejected = expect(result).rejects.toThrow('Sotto reasoning stopped.')
    try {
      let pid = 0
      await expect.poll(async () => {
        const calls = await f.calls().catch(() => [])
        const completion = calls.find(call => call.args.includes('--output-format') && call.args.includes('json'))
        pid = completion?.pid ?? 0
        return pid > 0
      }).toBe(true)
      shutdown.abort()
      await rejected
      expect(() => process.kill(pid, 0)).toThrow()
      const count = (await f.calls()).length
      await expect(f.client.complete('Return JSON.', {}, 'sonnet', undefined, shutdown.signal)).rejects.toThrow()
      expect(await f.calls()).toHaveLength(count)
    } finally { shutdown.abort(); await result.catch(() => undefined) }
  })
})

describe('Claude native subscription client', () => {
  it('reports only public account readiness and keeps prompts in stdin with all native tools disabled', async () => {
    const f = await fixture()
    const account = await f.client.status()
    expect(account).toMatchObject({ provider: 'claude', installed: true, ready: true })
    expect(JSON.stringify(account)).not.toContain('private-fixture')
    expect(account.models.map(model => model.id)).toContain('sonnet')
    const input = { utterance: 'fixture private prompt: $(do-not-run)' }
    expect(await f.client.complete('Return an intent as JSON.', input, 'sonnet')).toEqual({ type: 'clarify', text: 'Which project?' })
    const calls = await f.calls()
    const completion = calls.at(-1)!
    expect(completion.input).toContain(input.utterance)
    expect(completion.args.join(' ')).not.toContain(input.utterance)
    expect(completion.args).toEqual(expect.arrayContaining(['--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence', '--output-format', 'json', '--model', 'sonnet']))
    expect(completion.args).not.toContain('--bare')
    expect(calls.every(call => call.overrides.length === 0)).toBe(true)
    expect(f.environment.ANTHROPIC_API_KEY).toBe('fixture-other-account-key')
    expect(calls.filter(call => call.args.includes('status'))).toHaveLength(2)
  })

  it('rechecks the current subscription before every completion and does not fall back when signed out', async () => {
    const f = await fixture()
    await f.client.complete('JSON only', {}, 'sonnet')
    await f.configure({ auth: { loggedIn: false } })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/sign in.*subscription/iu)
    expect((await f.calls()).filter(call => call.args.includes('--print') && !call.args.includes('--input-format'))).toHaveLength(1)
  })

  it('discovers the full native catalog and per-model effort without inventing defaults or starting a model turn', async () => {
    const f = await fixture()
    const account = await f.client.status()
    expect(account).toMatchObject({ installed: true, ready: true, defaultModelId: 'default', allowCustomModel: true })
    expect(account.models).toEqual(nativeModels.map(model => ({ id: model.value, name: model.displayName, reasoningEfforts: model.supportedEffortLevels ?? [] })))
    expect(account.models.some(model => model.defaultReasoningEffort !== undefined)).toBe(false)
    expect(JSON.stringify(account)).not.toContain('private-fixture')
    const discovery = (await f.calls()).at(-1)!
    expect(discovery.args).toEqual(expect.arrayContaining(['--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json']))
    expect(JSON.parse(discovery.input)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    expect((await f.calls()).some(call => call.args.includes('--print') && !call.args.includes('--input-format'))).toBe(false)
  })

  it('uses the native account default for an empty model without passing API overrides', async () => {
    const f = await fixture()
    await expect(f.client.complete('JSON only', { check: 'default model' }, '')).resolves.toEqual({ type: 'clarify', text: 'Which project?' })
    const completion = (await f.calls()).at(-1)!
    expect(completion.args[completion.args.indexOf('--model') + 1]).toBe('default')
    expect(completion.args).not.toContain('--effort')
    expect(completion.overrides).toEqual([])
    expect(completion.args.some(arg => /api[ _-]?key/iu.test(arg))).toBe(false)
  })

  it('dispatches a newly discovered extended-context model with its chosen native effort', async () => {
    const f = await fixture()
    await f.client.complete('JSON only', {}, 'claude-future[1m]', 'xhigh')
    const completion = (await f.calls()).at(-1)!
    expect(completion.args[completion.args.indexOf('--model') + 1]).toBe('claude-future[1m]')
    expect(completion.args[completion.args.indexOf('--effort') + 1]).toBe('xhigh')
    expect(completion.overrides).toEqual([])
  })

  it.each([['haiku', 'high'], ['sonnet', 'max'], ['', 'medium'], ['claude-custom-id', 'high']] as const)('refuses unsupported effort %s/%s before inference instead of silently downshifting', async (model, effort) => {
    const f = await fixture()
    await expect(f.client.complete('JSON only', {}, model, effort)).rejects.toThrow(/effort/iu)
    expect((await f.calls()).some(call => call.args.includes('--print') && !call.args.includes('--input-format'))).toBe(false)
  })

  it('refreshes effort capabilities before each request and accepts custom native model IDs with default effort', async () => {
    const f = await fixture()
    await f.client.status()
    await f.configure({ models: nativeModels.map(model => model.value === 'sonnet' ? { ...model, supportedEffortLevels: ['low'] } : model) })
    await expect(f.client.complete('JSON only', {}, 'sonnet', 'high')).rejects.toThrow(/effort/iu)
    await f.client.complete('JSON only', {}, 'claude-custom-id[1m]')
    const completion = (await f.calls()).at(-1)!
    expect(completion.args[completion.args.indexOf('--model') + 1]).toBe('claude-custom-id[1m]')
    expect(completion.args).not.toContain('--effort')
  })

  it.each([{ models: [] }, { models: [{ value: '--injected-flag', displayName: 'Invalid' }] }, { discovery: 'error' }, { discovery: 'mismatch' }] as const)('does not substitute a handpicked catalog when native discovery fails', async scenario => {
    const f = await fixture(scenario)
    expect(await f.client.status()).toMatchObject({ installed: true, ready: false, models: [] })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/Claude Code/iu)
    expect((await f.calls()).some(call => call.args.includes('--print') && !call.args.includes('--input-format'))).toBe(false)
  })

  it('refuses a different native authentication method instead of using API billing', async () => {
    const f = await fixture({ auth: { loggedIn: true, authMethod: 'api_key' } })
    expect(await f.client.status()).toMatchObject({ installed: true, ready: false })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/subscription/iu)
    expect((await f.calls()).some(call => call.args.includes('--print'))).toBe(false)
  })

  it('requires the installed containment flags before declaring the account ready', async () => {
    const f = await fixture({ help: '--print --output-format --tools' })
    expect(await f.client.status()).toMatchObject({ installed: true, ready: false, detail: expect.stringMatching(/update claude code/iu) })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/update claude code/iu)
    expect((await f.calls()).some(call => call.args.includes('--print'))).toBe(false)
  })

  it('reports a missing executable without exposing a native path error', async () => {
    const f = await fixture()
    const client = new ClaudeSubscriptionClient(join(f.root, 'missing-cwd'), { executable: join(f.root, 'missing.exe') })
    expect(await client.status()).toMatchObject({ installed: false, ready: false })
    await expect(client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/install claude code/iu)
  })

  it.each(['exit', 'invalid'] as const)('reports a generic error for %s without exposing child output', async mode => {
    const f = await fixture({ mode })
    let message = ''
    try { await f.client.complete('JSON only', {}, 'sonnet') } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/claude code/iu)
    expect(message).not.toContain('fixture-secret')
  })

  it.each([
    { type: 'result', is_error: true, result: 'fixture-secret-provider-error' },
    { type: 'result', is_error: false, result: 'not JSON' },
    { type: 'result', is_error: false, result: 'null' },
  ])('rejects unsuccessful or malformed decision output', async result => {
    const f = await fixture({ result })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/claude code/iu)
  })

  it.each(['large-out', 'large-err'] as const)('bounds %s output', async mode => {
    const f = await fixture({ mode }, { outputLimitBytes: 4096 })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/output limit/iu)
    const pid = (await f.calls()).at(-1)!.pid
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('terminates a stalled completion at its deadline', async () => {
    const f = await fixture({ mode: 'timeout' }, { completionTimeoutMs: 300 })
    await expect(f.client.complete('JSON only', {}, 'sonnet')).rejects.toThrow(/in time/iu)
    const pid = (await f.calls()).at(-1)!.pid
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('rejects a flag-shaped model without starting inference', async () => {
    const f = await fixture()
    await expect(f.client.complete('JSON only', {}, '--dangerously-skip-permissions')).rejects.toThrow(/model/iu)
  })
})
