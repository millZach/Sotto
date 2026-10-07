// @vitest-environment node
// A Claude turn that ends in error: the provider says what happened in plain words, for the thread that failed.
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_TURN_FAILED, claudeTurnFailure } from '../../src/main/agents/claudeTurnFailure'
import { claudeFixture } from '../fixtures/claudeFixture'
import type { AgentHostSnapshot } from '../../src/shared/agents'

const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture() {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Failures', path: f.root })
  for (const id of ['thread', 'other']) {
    await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: f.projectId, title: id, modelId: f.modelId })
    await f.adapter.refreshThread(id)
  }
  return f
}
const failed = (fields: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: true, ...fields })
const error = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.host.snapshot()).error
const USAGE = 'Claude Code has reached your plan’s usage limit, so this turn stopped. Nothing in the thread was lost.'
const BUSY = 'Claude’s servers were busy or had a problem, so this turn stopped. Nothing in the thread was lost. This is usually brief: send again in a moment.'
const OFFLINE = 'Claude Code could not reach Claude’s servers, so this turn stopped. Nothing in the thread was lost. Check your internet connection, then send again.'
const SIGN_IN = 'Claude Code is not signed in, or its sign-in has expired, so this turn stopped. Nothing in the thread was lost. Sign in again in Claude Code, then send again.'
const MODEL = 'Claude Code could not use this thread’s model, so this turn stopped. Nothing in the thread was lost. Choose another model from the model chip, then send again.'

describe('the error a failed Claude turn leaves', () => {
  it.each([401, 429])('uses the friendly failure in turn activity and history publications for status %s', async status => {
    const f = await fixture()
    const snapshots: AgentHostSnapshot[] = []
    const unsubscribe = f.adapter.subscribeActivitySnapshots(snapshot => snapshots.push(snapshot), { historyFromEvents: true })
    try {
      await f.host.execute({ type: 'send', commandId: 'send', messageId: 'prompt', threadId: 'thread', text: 'Continue' })
      const raw = `API Error: ${status} {"request_id":"synthetic-request-id","message":"synthetic protocol body"}`
      const frame = failed({ result: raw, api_error_status: status })
      const expected = claudeTurnFailure(frame)
      await f.action('thread', { type: 'raw', frame })
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')?.activities?.find(activity => activity.kind === 'turn' && activity.status === 'failed')?.error).toBe(expected)
      expect(JSON.stringify(snapshots)).toContain(expected)
      expect(JSON.stringify(snapshots)).not.toContain(raw)
      expect(JSON.stringify(await f.host.snapshot())).not.toContain('synthetic-request-id')
    } finally { unsubscribe() }
  })
  it.each([
    ['a usage limit with its reset time', failed({ result: 'You’ve hit your limit · resets 3pm (America/Chicago)' }), undefined, `${USAGE} Send again after it resets at 3pm (America/Chicago).`],
    ['a usage limit with no reset time', failed({ result: 'API Error: 429 {"type":"rate_limit_error"}' }), 'rate_limit', `${USAGE} Send again once it resets; Claude Code shows when.`],
    ['an overloaded API', failed({ result: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', api_error_status: 529 }), undefined, BUSY],
    ['a server error', failed({ result: 'API Error: 500 Internal server error' }), 'server_error', BUSY],
    ['no connection', failed({ result: 'API Error: Connection error. (getaddrinfo ENOTFOUND api.anthropic.com)', api_error_status: null }), 'unknown', OFFLINE],
    ['an expired sign-in', failed({ result: 'OAuth token has expired. Please run /login', api_error_status: 401 }), 'authentication_failed', SIGN_IN],
    ['a model that is not available', failed({ result: 'API Error: 404 {"type":"not_found_error","message":"model: opus-9"}' }), 'model_not_found', MODEL],
    ['a model named only in the text', failed({ result: 'There’s an issue with the selected model (opus-9). It may not exist or you may not have access to it.' }), undefined, MODEL],
    ['the step limit', { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }, undefined,
      'Claude stopped this turn after the most steps it takes in one turn. What it did so far is kept. Send a message to let it carry on.'],
    ['the spending limit', { type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: [] }, undefined,
      'Claude stopped this turn at the spending limit set in Claude Code. What it did so far is kept. Raise the limit in Claude Code, then send a message to carry on.'],
    ['a conversation too long for the model', failed({ result: 'Prompt is too long', terminal_reason: 'prompt_too_long' }), undefined,
      'This thread’s conversation is too long for its model, so this turn stopped. Nothing in the thread was lost. Compact the thread or choose a model with more context, then send again.'],
    ['a reason Sotto does not know', { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool runner crashed: {"code":17}'] }, undefined, CLAUDE_TURN_FAILED],
  ] as const)('says %s in plain words, with no code or protocol body', (_, frame, assistantError, expected) => {
    const message = claudeTurnFailure(frame, assistantError)
    expect(message).toBe(expected)
    expect(message).not.toMatch(/\d{3}|\{|API Error|getaddrinfo/u)
  })

  it('reads the reset time Claude Code appends as epoch seconds', () => {
    expect(claudeTurnFailure(failed({ result: 'Claude AI usage limit reached|1760000000' }))).toMatch(/^Claude Code has reached your plan’s usage limit.*Send again after it resets at \d{1,2}[:.]\d{2}/u)
  })

  it('never reads a failed result’s own `result`, and sets no error for a turn the user stopped', () => {
    expect(claudeTurnFailure({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'usage limit reached' })).toBe(CLAUDE_TURN_FAILED)
    expect(claudeTurnFailure({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })).toBeNull()
    expect(claudeTurnFailure({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: [] })).toBeNull()
  })

  it('puts the failure on the provider and takes it down only when the thread that failed finishes a turn', async () => {
    const f = await fixture()
    await f.action('thread', { type: 'raw', frame: { type: 'assistant', error: 'rate_limit', message: { id: 'failure', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429' }] } } })
    await f.action('thread', { type: 'raw', frame: failed({ result: 'API Error: 429 rate limited' }) })
    await expect.poll(async () => error(f)).toBe(`${USAGE} Send again once it resets; Claude Code shows when.`)
    // Another thread finishing says nothing about this one.
    await f.driver.completeTurn('other', 'Finished elsewhere.')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'other')?.messages.at(-1)?.text).toBe('Finished elsewhere.')
    expect(await error(f)).toBe(`${USAGE} Send again once it resets; Claude Code shows when.`)
    await f.driver.completeTurn('thread', 'Finished after all.')
    await expect.poll(async () => error(f)).toBeUndefined()
  })

  it('sets no provider error when the user stops the turn', async () => {
    const f = await fixture()
    expect(await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })).toEqual({ accepted: true })
    await f.action('thread', { type: 'raw', frame: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] } })
    await f.driver.completeTurn('other', 'A later reply.')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'other')?.messages.at(-1)?.text).toBe('A later reply.')
    expect(await error(f)).toBeUndefined()
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'thread')?.status).toBe('idle')
  })
})
