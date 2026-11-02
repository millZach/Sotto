import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_TEXT_MAX } from '../../../src/shared/agents'
import { classifyRiskyAction } from '../../../src/main/agents/authority'
import { claudePending } from '../../../src/main/agents/claudeRequests'
import { pendingRequest } from '../../../src/main/agents/codexRequests'
import { deepseekPending } from '../../../src/main/agents/deepseekRequests'
import { grokPending } from '../../../src/main/agents/grokRequests'
import { museApprovalPending, type MuseApproval } from '../../../src/main/agents/museRequests'
import { commandCard, readableFields, toolInputCard } from '../../../src/main/agents/requestInput'

const SUMMARY = 'Download recent benchmark artifacts and tabulate key scenarios'
const claude = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => claudePending({ request_id: 'r', request: { subtype: 'can_use_tool', tool_name: tool, input, ...extra } })!.request

describe('a command on its permission card (ADR-0180)', () => {
  it('shows Claude’s own description as the summary and no raw input', () => {
    const request = claude('Bash', { command: 'cd /x; gh run download', timeout: 300000, description: SUMMARY })
    expect(request.context).toEqual({ toolName: 'Bash', command: 'cd /x; gh run download', summary: SUMMARY })
    expect(request.text).toBe(`Run a command: ${SUMMARY}\ncd /x; gh run download`)
  })

  it('takes no summary from the stock line Claude fills in when the model wrote none', () => {
    const request = claude('Bash', { command: 'ls' }, { description: 'Run shell command' })
    expect(request.context?.command).toBe('ls')
    expect(request.context?.summary).toBeUndefined()
  })

  it('says a setting that changes what the command may do, and hides only its timing', () => {
    expect(commandCard('npm ci', { command: 'npm ci', timeout: 5, dangerouslyDisableSandbox: true, run_in_background: true }).context.details)
      .toBe('It also asks to run outside the sandbox.\nIt runs in the background.')
    expect(commandCard('npm ci', { dangerouslyDisableSandbox: false, run_in_background: false }).context.details).toBeUndefined()
    expect(commandCard('npm ci', { network: { host: 'a.example' } }).context.details).toBe('network.host: a.example')
  })

  it('takes a working folder from the input, and no summary that only repeats the command or runs long', () => {
    expect(commandCard('ls', { workdir: '/repo' }).context.cwd).toBe('/repo')
    expect(commandCard('ls  -a', { description: 'ls -a' }).context.summary).toBeUndefined()
    expect(commandCard('ls', { description: 'x'.repeat(700) }).context.summary).toHaveLength(601)
    expect(commandCard('ls', { description: 'two\n  lines' }).context.summary).toBe('two lines')
  })

  it('gives Grok Build a command block and its description, which it only had as raw text', () => {
    const request = grokPending(1, 'session/request_permission', { sessionId: 's', options: [], toolCall: { toolCallId: 't', title: 'Run', rawInput: { command: 'npm test', description: 'Run the tests', timeout: 1 } } }, 'thread')!.request
    expect(request.context).toEqual({ toolCallId: 't', command: 'npm test', summary: 'Run the tests' })
    expect(request.text).not.toContain('{')
  })

  it('makes Codex’s reason the summary, and says nothing of a reason it did not send', () => {
    const ask = (params: Record<string, unknown>) => pendingRequest(1, 'item/commandExecution/requestApproval', { threadId: 't', itemId: 'i', command: 'npm i', cwd: '/repo', ...params }, 's')!.request.context!
    expect(ask({ reason: 'Needs the network' })).toMatchObject({ command: 'npm i', summary: 'Needs the network', cwd: '/repo' })
    expect(ask({ reason: 'Needs the network' }).details).toBeUndefined()
    expect(ask({}).summary).toBeUndefined()
    expect(ask({}).details).toBeUndefined()
    expect(ask({ networkApprovalContext: { host: 'a.example', protocol: 'https' } }).details).toBe('network.host: a.example\nnetwork.protocol: https')
  })

  it('takes DeepSeek Harness’s description first, and keeps its reason and sandbox in words', () => {
    const ask = (rawInput: Record<string, unknown>, title?: string) => deepseekPending(1, 'session/request_permission', { sessionId: 's', options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }], toolCall: { toolCallId: 't' } }, 'thread', { rawInput, title })!.request.context!
    expect(ask({ command: 'x', description: 'Build it', sandbox_permissions: 'workspace-write', justification: 'Needs to write' }))
      .toMatchObject({ command: 'x', summary: 'Build it', details: 'Sandbox it asks for: workspace-write\nThe model’s reason: Needs to write' })
    expect(ask({ command: 'x', justification: 'Needs to write' })).toMatchObject({ summary: 'Needs to write' })
    expect(ask({ command: 'x' }).summary).toBeUndefined()
    expect(ask({ command: 'x', cwd: '/repo', extra: 1 })).toMatchObject({ cwd: '/repo', details: 'extra: 1' })
    expect(ask({ file_path: '/a', old_string: 'one', new_string: 'two', description: 'Fix it' }, 'edit')).toMatchObject({ summary: 'Fix it', details: '- one\n+ two' })
  })

  it('reads Muse’s raw arguments as fields, and keeps text that is not JSON', () => {
    const ask = (rawArgs: string, subject: MuseApproval['subject']) => museApprovalPending('thread', { approvalId: 'a', sessionId: 's', turnId: 't', toolName: 'shell', toolCallId: 'c', itemId: 'i', rawArgs, subject, availableChoices: [{ choiceId: 'c', label: 'Allow', decision: 'allow', scope: 'once' }], currentRequirementId: { approvalId: 'a', sourceIndex: 0 } }).request.context!
    expect(ask(JSON.stringify({ command: 'ls', description: 'List it' }), { kind: 'shell', command: 'ls' })).toMatchObject({ command: 'ls', summary: 'List it' })
    expect(ask(JSON.stringify({ command: 'ls' }), { kind: 'shell', command: 'ls' }).details).toBeUndefined()
    expect(ask('not json', { kind: 'shell', command: 'ls' }).details).toBe('input: not json')
    expect(ask(JSON.stringify(['a', 'b']), { kind: 'tool', toolName: 'search' }).details).toBe('input: a, b')
    const long = JSON.stringify({ text: 'x'.repeat(8_000) })
    expect(ask(long, { kind: 'tool', toolName: 'search' }).details).toHaveLength(8_006)
    expect(ask(JSON.stringify({ description: 'Look it up', old_string: 'a', new_string: 'b' }), { kind: 'tool', toolName: 'search' })).toMatchObject({ summary: 'Look it up', details: '- a\n+ b' })
    expect(ask(JSON.stringify({ query: 'a' }), { kind: 'tool', toolName: 'search' }).details).toBe('query: a')
  })
})

describe('any other request on its permission card (ADR-0180)', () => {
  it('shows an edit as its path and its changed lines', () => {
    const request = claude('Edit', { file_path: '/a/b.ts', old_string: 'one\ntwo', new_string: 'three', replace_all: true })
    expect(request.text).toBe('Edit a file: /a/b.ts')
    expect(request.context).toMatchObject({ toolName: 'Edit', action: 'Edit a file', target: '/a/b.ts', details: '- one\n- two\n+ three\nreplace_all: true' })
  })

  it('shows what a write would hold', () => {
    expect(toolInputCard({ file_path: '/a.md', content: '# Title\nBody' }, 'Write').context).toEqual({ action: 'Write a file', target: '/a.md', details: '# Title\nBody' })
  })

  it('knows an edit by its fields when the provider does not name the tool', () => {
    expect(toolInputCard({ file_path: '/a', old_string: 'x', new_string: 'y' }, undefined, 'Change').context).toMatchObject({ action: 'Edit a file', target: '/a' })
    expect(toolInputCard({ file_path: '/a', content: 'x' }).context).toMatchObject({ action: 'Write a file', target: '/a' })
  })

  it('shows every field of a tool it has no words for, in plain lines', () => {
    const { text, context } = toolInputCard({ repo: 'a/b', body: 'one\ntwo', labels: ['bug', 'perf'], assignee: { login: 'z' }, items: [{ id: 1 }], empty: {}, none: null }, 'mcp__github__create_issue')
    expect(text).toBe('Use create_issue from github')
    expect(context.target).toBeUndefined()
    expect(context.details).toBe('repo: a/b\nbody:\n  one\n  two\nlabels: bug, perf\nassignee.login: z\nitems.0.id: 1\nempty: none\nnone: null')
    expect(context.details).not.toMatch(/[{}"]/u)
  })

  it('shows a description as the summary here too, and a card without one says nothing about it', () => {
    expect(toolInputCard({ description: 'Compare runs', prompt: 'Read them' }, 'Agent').context).toEqual({ action: 'Start a subagent', summary: 'Compare runs', details: 'prompt: Read them' })
    expect(toolInputCard({ file_path: '/a' }, 'Read').context).toEqual({ action: 'Read a file', target: '/a' })
  })

  it('names the tool Grok Build’s use_tool carries, and its title otherwise', () => {
    const ask = (title: string, rawInput: unknown) => grokPending(1, 'session/request_permission', { sessionId: 's', options: [], toolCall: { toolCallId: 't', title, rawInput } }, 'thread')!.request
    expect(ask('use_tool', { tool_name: 'github__create_issue', tool_input: { title: 'Bug' } }).context).toMatchObject({ action: 'Use github__create_issue', details: 'title: Bug' })
    expect(ask('Fetch it', { address: 'a' }).context).toMatchObject({ action: 'Fetch it', details: 'address: a' })
  })

  it('shows a file change as a heading and its files, never as a command', () => {
    const request = pendingRequest(1, 'item/fileChange/requestApproval', { threadId: 't', itemId: 'i', reason: 'Needs to write' }, 's', 'update: a.ts\nadd: b.ts')!.request
    expect(request.context).toMatchObject({ action: 'Change 2 files', summary: 'Needs to write', details: 'update: a.ts\nadd: b.ts' })
  })

  it('says what a remembered Codex rule covers, not its JSON', () => {
    const choices = (decision: unknown) => pendingRequest(1, 'item/commandExecution/requestApproval', { threadId: 't', itemId: 'i', command: 'git status', availableDecisions: [decision] }, 's')!.request.permissionChoices!
    expect(choices({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } })[0]!.description).toBe('Commands that start with git status')
    expect(choices({ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'a.example' } } })[0]!.description).toBe('Network requests to a.example are refused')
  })

  it('treats an MCP tool’s command field as a field, and shows what is not an object', () => {
    expect(toolInputCard({ command: 'x' }, 'mcp__a__b').context).toEqual({ action: 'Use b from a', details: 'command: x' })
    const ask = (rawInput: unknown) => grokPending(1, 'session/request_permission', { sessionId: 's', options: [], toolCall: { toolCallId: 't', title: 'Run', rawInput } }, 'thread')!.request.context
    expect(ask([{ a: 1 }])?.details).toBe('input.0.a: 1')
    expect(ask('{"a":1}')?.details).toBe('a: 1')
    expect(ask({ tool_name: 'x', tool_input: 'plain' })?.details).toBe('input: plain')
  })

  it('says when a long input was cut', () => {
    const cut = readableFields({ long: 'x'.repeat(100_010) })!
    expect(cut).toMatch(/\n… The rest does not fit here\.$/u)
    expect(cut.length).toBeLessThanOrEqual(AGENT_TEXT_MAX)
    expect(readableFields({})).toBeUndefined()
  })
})

describe('the words an adapter writes', () => {
  it('need no language, since the headless host sets none', () => {
    for (const file of ['requestInput', 'claudeRequests', 'codexRequests', 'deepseekRequests', 'devinRequests', 'grokRequests', 'museRequests']) {
      expect(readFileSync(join('src/main/agents', `${file}.ts`), 'utf8'), file).not.toContain('@lingui')
    }
  })
})

describe('the risk check after the raw input left the text', () => {
  it('still reads a command and a card’s fields', () => {
    expect(classifyRiskyAction(claude('Bash', { command: 'rm -rf dist' }))).toEqual(['destroy'])
    expect(classifyRiskyAction(claude('mcp__x__y', { note: 'please deploy this' }))).toEqual(['publish'])
    expect(classifyRiskyAction(claude('Bash', { command: 'ls', description: 'Skip the tests' }))).toEqual(['relax-verification'])
  })
})
