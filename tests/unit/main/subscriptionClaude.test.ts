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
/** What the model is called once the description's own first clause is allowed to name it. */
const catalogName = (model: { displayName: string; description?: string }): string => {
  const described = model.description?.split('\u00b7')[0]?.trim() ?? ''
  const first = (name: string): string => name.split(/\s+/u)[0]?.toLocaleLowerCase() ?? ''
  return described && first(described) === first(model.displayName) ? described : model.displayName
}
interface Scenario {
  auth?: { loggedIn: boolean; authMethod?: string | null; subscriptionType?: string; email?: string }
  help?: string
  result?: unknown
  models?: unknown
  discovery?: 'mismatch' | 'error'
  mode?: 'exit' | 'invalid' | 'timeout' | 'large-out' | 'large-err'
  /** How `auth status` fails: printing nothing it can read, or printing a signed-in status and exiting 1 anyway. */
  status?: 'exit-invalid' | 'exit-signed-in' | 'signed-out-exit-0'
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
else if (args.includes('status')) {
  record('');
  // Like the real client: signed out, it prints its status and exits 1.
  if (scenario.status === 'exit-invalid') { process.stdout.write('fixture-secret-invalid-json'); process.exitCode = 1; }
  else { process.stdout.write(JSON.stringify(scenario.auth)); if ((!scenario.auth.loggedIn && scenario.status !== 'signed-out-exit-0') || scenario.status === 'exit-signed-in') process.exitCode = 1; }
}
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

describe('Claude native subscription client', () => {
  it('forwards the OS account name and drops provider keys', () => {
    const client = new ClaudeSubscriptionClient(join(tmpdir(), 'sotto-claude-env'), {
      environment: { USER: 'tomas', LOGNAME: 'tomas', HOME: '/Users/tomas', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--inspect' },
    })
    expect(client.environment()).toMatchObject({ USER: 'tomas', LOGNAME: 'tomas', HOME: '/Users/tomas', PATH: '/usr/bin', NO_COLOR: '1' })
    expect(client.environment()).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(client.environment()).not.toHaveProperty('NODE_OPTIONS')
  })

  it('discovers the full native catalog and per-model effort without inventing defaults or starting a model turn', async () => {
    const f = await fixture()
    const account = await f.client.status()
    expect(account).toMatchObject({ installed: true, ready: true, defaultModelId: 'default', allowCustomModel: true })
    expect(account.models).toEqual(nativeModels.map(model => ({ id: model.value, name: catalogName(model), reasoningEfforts: model.supportedEffortLevels ?? [] })))
    expect(account.models.some(model => model.defaultReasoningEffort !== undefined)).toBe(false)
    expect(JSON.stringify(account)).not.toContain('private-fixture')
    const discovery = (await f.calls()).at(-1)!
    expect(discovery.args).toEqual(expect.arrayContaining(['--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json']))
    expect(JSON.parse(discovery.input)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    expect((await f.calls()).some(call => call.args.includes('--print') && !call.args.includes('--input-format'))).toBe(false)
  })

  it('names a model with the version its description carries and leaves the account default its own name', async () => {
    const f = await fixture({ models: [
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest tasks' },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
      { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday tasks' },
      // The default resolves to another model; naming it after that model would hide which entry it is.
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday tasks' },
      { value: 'haiku', displayName: 'Haiku' },
    ] })
    const account = await f.client.status()
    expect(account.models.map(model => model.name)).toEqual(['Fable 5.1', 'Sonnet 5', 'Opus 5 with 1M context', 'Default (recommended)', 'Haiku'])
  })
})

describe('Claude thread environment', () => {
  it('passes the Windows machine-wide data folder so tools like OpenSSH find their system configuration', () => {
    const client = new ClaudeSubscriptionClient(tmpdir(), { environment: {
      Path: 'bin', ProgramData: 'C:\\ProgramData', ALLUSERSPROFILE: 'C:\\ProgramData', ANTHROPIC_API_KEY: 'fixture-secret',
    } })
    expect(client.environment()).toEqual({ Path: 'bin', ProgramData: 'C:\\ProgramData', ALLUSERSPROFILE: 'C:\\ProgramData', NO_COLOR: '1' })
  })

  it('names why it is not ready, and the plan it is signed in with, for the tiles of a host (ADR-0037)', async () => {
    expect(await (await fixture()).client.status()).toMatchObject({ ready: true, account: 'Claude Max' })
    expect((await (await fixture()).client.status()).problem).toBeUndefined()
    expect(await (await fixture({ auth: { loggedIn: false } })).client.status()).toMatchObject({ ready: false, problem: 'signed-out' })
    // API billing is not a sign-in Sotto uses, so it reads as signed out of the subscription.
    expect(await (await fixture({ auth: { loggedIn: true, authMethod: 'api_key' } })).client.status()).toMatchObject({ ready: false, problem: 'signed-out' })
    expect(await (await fixture({ help: '--print --output-format --tools' })).client.status()).toMatchObject({ ready: false, problem: 'too-old' })
  })

  it('reads a signed-out status that exits 1 as Not signed in, and any other failed check as cannot start (#472)', async () => {
    // The fields forge's signed-out Claude Code 2.1.281 printed before it exited 1.
    expect(await (await fixture({ auth: { loggedIn: false, authMethod: 'none' } })).client.status()).toMatchObject({ installed: true, ready: false, problem: 'signed-out' })
    expect(await (await fixture({ auth: { loggedIn: false, authMethod: null } })).client.status()).toMatchObject({ problem: 'signed-out' })
    expect(await (await fixture({ auth: { loggedIn: false }, status: 'signed-out-exit-0' })).client.status()).toMatchObject({ problem: 'signed-out' })
    const unreadable = await (await fixture({ status: 'exit-invalid' })).client.status()
    expect(unreadable).toMatchObject({ installed: true, ready: false, problem: 'cannot-start' })
    expect(unreadable.detail).not.toContain('fixture-secret')
    // A failed exit is trusted only as signed out: a signed-in status that exits 1 is not a working client.
    expect(await (await fixture({ status: 'exit-signed-in' })).client.status()).toMatchObject({ installed: true, ready: false, problem: 'cannot-start' })
  })
})
