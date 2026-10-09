// @vitest-environment node
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AgentIntent } from '../../../src/main/agents/reasoning'
import { type AgentCommand } from '../../../src/shared/agents'
import { UnacknowledgedCreationHost, fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('clarification recovery', () => {
  it('asks for the thread before capturing a prompt prefix when no thread is selected', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const question = await f.control.command({ type: 'utterance', text: "Here's my prompt: Keep the existing colors." })
    expect(question.error).toBeNull()
    expect(question.pendingRequest).toContain('Keep the existing colors.')
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors.' }
    const answer = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(answer).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop', composing: true })
  })

  it('begins listening after a thread clarification when no prompt has been dictated yet', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    await f.control.command({ type: 'utterance', text: 'I want to add a prompt to a thread.' })
    f.service.intent = { type: 'compose', threadId: 'workshop', text: '' }
    const selected = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(selected).toMatchObject({ error: null, composing: true, draftThreadId: 'workshop', draft: '' })
    const dictated = await f.control.command({ type: 'utterance', text: 'Keep the existing colors.' })
    expect(dictated).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop' })
    expect(f.requests).toHaveLength(2)
  })

  it('requires explicit management before sending a prepared prompt to an unassigned thread', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors.' }
    const drafted = await f.control.command({ type: 'utterance', text: 'Add a prompt to Workshop: Keep the existing colors.' })
    expect(drafted).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop', assignments: [] })
    const blocked = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(blocked.error).toContain('Assign this thread')
    expect(blocked.draft).toBe('Keep the existing colors.')
    const managed = await f.control.command({ type: 'utterance', text: 'Manage Workshop.' })
    expect(managed).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop' })
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.host.threads.find(thread => thread.id === 'workshop')?.messages).toHaveLength(1)
  })

  it('keeps the pending prompt and presents a readable error when its clarification has an invalid model response', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const pending = await f.control.command({ type: 'utterance', text: 'Add a prompt: Keep the existing colors.' })
    f.service.intent = { type: 'submit', threadId: 'workshop' } as unknown as AgentIntent
    const failed = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(failed.error).toContain('Sotto could not interpret')
    expect(failed.error).not.toContain('invalid_union')
    expect(failed.pendingRequest).toBe(pending.pendingRequest)
    expect(failed.host.threads.every(thread => thread.messages.length === 0)).toBe(true)
  })

  it.each(['Workshop.', 'Select Workshop.', 'Open Workshop.'])('retains a spoken prompt through naming its thread (%s) and sends only after explicit confirmation', async clarification => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const clarified = await f.control.command({ type: 'utterance', text: 'Add a prompt to a thread: Keep the existing colors and fix the heading.' })
    expect(clarified.pendingRequest).toContain('Keep the existing colors and fix the heading.')
    await f.restart()
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors and fix the heading.' }
    const named = await f.control.command({ type: 'utterance', text: clarification })
    expect(named.error).toBeNull()
    expect(named).toMatchObject({ activeThreadId: 'workshop', draftThreadId: 'workshop', draft: 'Keep the existing colors and fix the heading.', composing: true, pendingRequest: '' })
    expect(f.requests.at(-1)?.utterance).toContain(`User clarification: ${clarification}`)
    expect(named.host.threads.every(thread => thread.messages.length === 0)).toBe(true)
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.host.threads.find(thread => thread.id === 'workshop')?.messages).toMatchObject([{ role: 'user', text: 'Keep the existing colors and fix the heading.' }])
    expect(sent.host.threads.find(thread => thread.id === 'docs')?.messages).toEqual([])
  })

  it('retains a valid spoken project request and its execution failure for a corrective folder reply', async () => {
    const f = await fixture()
    await f.account()
    const existing = join(f.root, 'existing-project')
    await mkdir(existing)
    f.service.intent = { type: 'create-project', title: 'Lantern', path: existing }
    const failed = await f.control.command({ type: 'utterance', text: `Create a project called Lantern in ${existing}.` })
    expect(failed.error).toMatch(/folder already exists/iu)
    expect(failed.pendingRequest).toContain('Create a project called Lantern')
    expect(failed.pendingRequest).toContain(failed.error)
    await f.restart()
    const corrected = join(f.root, 'corrected-project')
    f.service.intent = { type: 'create-project', title: 'Lantern', path: corrected }
    const done = await f.control.command({ type: 'utterance', text: `Use ${corrected} instead.` })
    expect(done.error).toBeNull()
    expect(f.requests.at(-1)?.utterance).toContain('Create a project called Lantern')
    expect(f.requests.at(-1)?.utterance).toContain('folder already exists')
    expect(f.requests.at(-1)?.utterance).toContain(`User clarification: Use ${corrected} instead.`)
    expect(done.host.projects.filter(project => project.title === 'Lantern')).toMatchObject([{ path: corrected }])
    expect(done.pendingRequest).toBe('')
  })

  it('retains a valid spoken thread request when its selected model cannot execute', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'create-thread', title: 'Lantern implementation', projectId: 'project', modelId: 'missing:model' }
    const failed = await f.control.command({ type: 'utterance', text: 'Create a thread called Lantern implementation with the experimental model.' })
    expect(failed.error).toMatch(/model or account is unavailable/iu)
    expect(failed.pendingRequest).toContain('Lantern implementation')
    f.service.intent = { type: 'create-thread', title: 'Lantern implementation', projectId: 'project', modelId: 'claude:test' }
    const done = await f.control.command({ type: 'utterance', text: 'Use Claude Test instead.' })
    expect(done.error).toBeNull()
    expect(f.requests.at(-1)?.utterance).toContain('Lantern implementation')
    expect(f.requests.at(-1)?.utterance).toContain('model or account is unavailable')
    expect(done.host.threads.filter(thread => thread.title === 'Lantern implementation')).toHaveLength(1)
    expect(done.pendingRequest).toBe('')
  })

  it.each(['create-project', 'create-thread'] as const)('blocks fresh creation intents while %s has an unknown acknowledgment, including after restart', async type => {
    const host = new UnacknowledgedCreationHost()
    const f = await fixture(host)
    await f.account()
    f.service.intent = type === 'create-project'
      ? { type, title: 'Lantern', path: join(f.root, 'first-project') }
      : { type, title: 'Lantern', projectId: 'project', modelId: 'claude:test' }
    const failed = await f.control.command({ type: 'utterance', text: 'Create Lantern.' })
    expect(failed.error).toMatch(/did not confirm/iu)
    await f.restart()
    const retry = await f.control.command({ type: 'utterance', text: 'Try creating it again.' })
    expect(retry.error).toMatch(/unknown result/iu)
    const alternativePath = join(f.root, 'must-not-be-created')
    const another = await f.control.command({ type: 'create-project', title: 'Another', path: alternativePath })
    expect(another.error).toMatch(/unknown result/iu)
    await expect(stat(alternativePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(host.creationAttempts).toHaveLength(1)
    await host.revealOriginalCreation()
    const observed = await f.control.command({ type: 'refresh' })
    const existing = type === 'create-project'
      ? observed.host.projects.find(project => project.title === 'Lantern')!
      : observed.host.threads.find(thread => thread.title === 'Lantern')!
    const selected = await f.control.command(type === 'create-project'
      ? { type: 'select-project', projectId: existing.id } : { type: 'select-thread', threadId: existing.id })
    expect(selected.error).toBeNull()
    expect(selected.pendingRequest).toBe('')
    expect(host.creationAttempts).toHaveLength(1)
  })

  it.each(['unconfigured', 'missing-key', 'offline'] as const)('does not turn a %s failure into a saved clarification', async failure => {
    const f = await fixture()
    if (failure !== 'unconfigured') await f.account()
    if (failure === 'missing-key') await f.control.command({ type: 'credential', slot: 'reasoning', value: '' })
    if (failure === 'offline') f.service.offline = true
    const failed = await f.control.command({ type: 'utterance', text: 'Create a project called Forgotten.' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe('')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).pendingRequest).toBe('')
    await f.restart()
    await f.account()
    f.service.offline = false
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests.at(-1)?.utterance).toBe('Choose the test project.')
  })

  it('preserves a genuine clarification through a failed retry and restart without accumulating the failed reply', async () => {
    const f = await fixture()
    const clarified = await f.clarification()
    const pending = clarified.pendingRequest
    expect(pending).toContain('Create a project called Lantern.')
    f.service.offline = true
    const failed = await f.control.command({ type: 'utterance', text: 'Use my old folder.' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe(pending)
    await f.restart()
    expect(f.control.get().pendingRequest).toBe(pending)
    f.service.offline = false
    f.service.intent = { type: 'select-project', projectId: 'project' }
    const done = await f.control.command({ type: 'utterance', text: 'Use the test project instead.' })
    expect(done.pendingRequest).toBe('')
    expect(f.requests.at(-1)?.utterance).toBe(`${pending}\nUser clarification: Use the test project instead.`)
  })

  it.each(['select-project', 'select-thread', 'create-project', 'create-thread'] as const)('clears a superseded clarification after successful explicit %s', async type => {
    const f = await fixture()
    await f.clarification()
    const actions: Record<typeof type, AgentCommand> = {
      'select-project': { type: 'select-project', projectId: 'project' },
      'select-thread': { type: 'select-thread', threadId: 'workshop' },
      'create-project': { type: 'create-project', title: 'Direct project', path: join(f.root, 'direct-project') },
      'create-thread': { type: 'create-thread', projectId: 'project', title: 'Direct thread', modelId: 'claude:test' },
    }
    const done = await f.control.command(actions[type])
    expect(done.error).toBeNull()
    expect(done.pendingRequest).toBe('')
  })

  it('keeps a genuine clarification when an explicit action fails or the queue changes in the background', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'docs' })
    const { pendingRequest } = await f.clarification()
    const failed = await f.control.command({ type: 'select-project', projectId: 'missing-project' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe(pendingRequest)
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose the heading.' })
    await f.control.command({ type: 'refresh' })
    const moved = await f.control.command({ type: 'later' })
    expect(moved.pendingRequest).toBe(pendingRequest)
  })
})
