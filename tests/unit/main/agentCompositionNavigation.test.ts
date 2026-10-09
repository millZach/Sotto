// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('composition navigation and explicit spoken controls', () => {
  it('previews the configured voice while agents are disabled without inference or host work', async () => {
    const f = await fixture()
    await f.control.command({ type: 'disconnect' })
    const before = f.control.get()
    const previewed = await f.control.command({ type: 'preview-voice' })
    expect(previewed).toMatchObject({ error: null, configuration: { enabled: false },
      speech: { id: before.speech.id + 1, text: 'Hi, I’m Sotto. Your agents are ready when you are.', preview: true } })
    expect(previewed.host).toEqual(before.host)
    expect(previewed.assignments).toEqual(before.assignments)
    expect(f.requests).toEqual([])
  })

  it.each(['button', 'spoken', 'pending question'] as const)('returns from hidden prompt dictation to conversation through the %s without losing the draft', async source => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    if (source === 'pending question') {
      f.host.event({ type: 'question', threadId: 'workshop', text: 'Which colors?', requestId: 'color-question' })
      await f.control.command({ type: 'refresh' })
    }
    await f.control.command({ type: 'compose', text: 'Keep the existing colors.' })
    const paused = await f.control.command(source === 'button' ? { type: 'pause-draft' } : { type: 'utterance', text: 'Talk to Sotto.' })
    expect(paused).toMatchObject({ error: null, composing: false, draft: '', draftThreadId: null, activeThreadId: null })
    expect(paused.threadDrafts).toMatchObject([{ threadId: 'workshop', text: 'Keep the existing colors.' }])
    await f.restart()
    f.service.intent = { type: 'clarify', text: 'What would you like to review?' }
    const answered = await f.control.command({ type: 'utterance', text: 'How are you doing today?' })
    expect(f.requests.at(-1)?.utterance).toBe('How are you doing today?')
    expect(answered.speech.text).toBe('What would you like to review?')
    expect(answered.threadDrafts).toMatchObject([{ threadId: 'workshop', text: 'Keep the existing colors.' }])
    expect(answered.host.threads.find(thread => thread.id === 'workshop')?.messages).toHaveLength(0)
    const resumed = await f.control.command({ type: 'resume-draft', threadId: 'workshop' })
    expect(resumed).toMatchObject({ error: null, composing: true, draft: 'Keep the existing colors.', draftThreadId: 'workshop',
      draftRequestId: source === 'pending question' ? 'color-question' : null })
  })

  it('keeps the saved revision and skills when a resume command is repeated', async () => {
    const f = await fixture()
    const draftId = '643812b8-aed2-4eaf-8cc5-cd5174103c1a'
    const skills = [{ name: 'review', path: 'D:\\Workshop\\SKILL.md' }]
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId, text: 'Please review this.', skills })
    await f.control.command({ type: 'resume-draft', threadId: 'workshop' })
    const resumed = await f.control.command({ type: 'resume-draft', threadId: 'workshop' })
    expect(resumed.threadDrafts?.find(draft => draft.threadId === 'workshop')).toMatchObject({ draftId, skills })
    expect(resumed.assignments).toEqual([])
  })

  it.each(['empty', 'permission'] as const)('answers the home attention suggestion directly and repeatedly with an %s queue', async kind => {
    const f = await fixture()
    if (kind === 'permission') {
      await f.control.command({ type: 'assign', threadId: 'workshop' })
      f.host.event({ type: 'permission', threadId: 'workshop', text: 'Publish the project?', requestId: 'publish' })
      await f.control.command({ type: 'refresh' })
    }
    const before = f.control.get()
    for (const text of ['What needs my attention?', 'What needs my attention?']) {
      const result = await f.control.command({ type: 'utterance', text })
      expect(result.error).toBeNull()
      expect(result.speech.text).toBe(kind === 'empty' ? 'Nothing is queued for your attention.' : '1 item in your attention queue. Workshop: Publish the project?')
      expect(result.speech.id).toBeGreaterThan(before.speech.id)
      expect(result.host.threads).toEqual(before.host.threads)
      expect(result.queue).toEqual(before.queue)
      expect(result.composing).toBe(false)
    }
    expect(f.requests).toEqual([])
  })

  it('returns to the selected question after explicitly moving next from coordinator conversation', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'docs' })
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Keep the colors.' })
    await f.control.command({ type: 'pause-draft' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose colors.', requestId: 'colors' })
    await f.control.command({ type: 'refresh' })
    await f.control.command({ type: 'next' })
    const answered = await f.control.command({ type: 'utterance', text: 'Blue please.' })
    expect(answered).toMatchObject({ composing: true, draftThreadId: 'docs', draftRequestId: 'colors', draft: 'Blue please.' })
    expect(answered.threadDrafts?.find(draft => draft.threadId === 'workshop')?.text).toBe('Keep the colors.')
    expect(f.requests).toEqual([])
  })

  it('does not replace a saved thread draft with unbound recovered text when resuming', async () => {
    const f = await fixture()
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: '643812b8-aed2-4eaf-8cc5-cd5174103c1a', text: 'Saved Workshop prompt.' })
    f.control.dispose()
    const file = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    // Provider retirement retains text without binding it or enabling composition.
    await writeFile(file, JSON.stringify({ ...saved, draft: 'Recovered provider prompt.', draftThreadId: null, composing: false }))
    await f.restart()
    const resumed = await f.control.command({ type: 'resume-draft', threadId: 'workshop' })
    expect(resumed.error).not.toBeNull()
    expect(resumed).toMatchObject({ draft: 'Recovered provider prompt.', draftThreadId: null, composing: false })
    expect(resumed.threadDrafts?.find(draft => draft.threadId === 'workshop')?.text).toBe('Saved Workshop prompt.')
  })

  it('dictates and sends the first prompt immediately after creating a managed thread without reasoning', async () => {
    const f = await fixture()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'New voice thread', modelId: 'claude:test' })
    const threadId = created.activeThreadId!
    expect(created).toMatchObject({ error: null, composing: true, draft: '', draftThreadId: threadId })
    const dictated = await f.control.command({ type: 'utterance', text: 'Build a settings page with the existing colors.' })
    expect(dictated.draft).toBe('Build a settings page with the existing colors.')
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.composing).toBe(false)
    expect(sent.host.threads.find(thread => thread.id === threadId)?.messages).toMatchObject([
      { role: 'user', text: 'Build a settings page with the existing colors.' },
    ])
    expect(f.requests).toEqual([])
  })

  it.each(["Here's my prompt: Build the page.", 'Start prompt'])('keeps the optional prompt prefix after creating a thread: %s', async text => {
    const f = await fixture()
    await f.control.command({ type: 'create-thread', projectId: 'project', title: 'New voice thread', modelId: 'claude:test' })
    const dictated = await f.control.command({ type: 'utterance', text })
    expect(dictated.error).toBeNull()
    expect(dictated.draft).toBe(text === 'Start prompt' ? '' : 'Build the page.')
    expect(dictated.composing).toBe(true)
    expect(f.requests).toEqual([])
  })

  it('adopts the thread ID the window minted, refuses to create it twice, and still mints one when none is given', async () => {
    const f = await fixture()
    const threadId = randomUUID()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Minted in the window', modelId: 'claude:test', threadId })
    expect(created).toMatchObject({ error: null, activeThreadId: threadId })
    expect(created.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const duplicate = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Same ID again', modelId: 'claude:test', threadId })
    expect(duplicate.error).toBe('This thread already exists. Select it instead of creating it again.')
    expect(duplicate.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const minted = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Main mints this one', modelId: 'claude:test' })
    expect(minted.error).toBeNull()
    expect(minted.activeThreadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(minted.activeThreadId).not.toBe(threadId)
  })

  it('preserves an unfinished draft and creates no extra thread when creation is blocked', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Finish Workshop first.' })
    const blocked = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Another thread', modelId: 'claude:test' })
    expect(blocked.error).toMatch(/send or clear your draft/iu)
    expect(blocked).toMatchObject({ draft: 'Finish Workshop first.', draftThreadId: 'workshop', activeThreadId: 'workshop' })
    expect(blocked.host.threads).toHaveLength(2)
  })

  it('pins a newly created thread while another completed thread is queued, including after clearing the empty draft', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Workshop is ready for review.' })
    await f.control.command({ type: 'refresh' })
    expect(f.control.get().queue.some(item => item.threadId === 'workshop')).toBe(true)
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Beta', modelId: 'claude:test' })
    const beta = created.host.threads.find(thread => thread.title === 'Beta')!
    expect(created).toMatchObject({ activeThreadId: beta.id, draftThreadId: beta.id, composing: true })
    const refreshed = await f.control.command({ type: 'refresh' })
    expect(refreshed).toMatchObject({ activeThreadId: beta.id, draftThreadId: beta.id })
    expect(refreshed.queue.some(item => item.threadId === 'workshop')).toBe(true)
    await f.control.command({ type: 'cancel-draft' })
    const cleared = await f.control.command({ type: 'refresh' })
    expect(cleared.activeThreadId).toBe(beta.id)
    const next = await f.control.command({ type: 'utterance', text: 'Next' })
    expect(next.activeThreadId).toBe('workshop')
  })

  it.each(['con.txt', 'NUL.log', 'aux.archive.tar', 'COM1.txt', 'lpt9.log', 'LPT¹', 'com³.txt', 'nul .txt', 'CON  .log'])('refuses the Windows device folder name %s before creating it', async title => {
    const f = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const execute = vi.spyOn(f.host, 'execute')
      const result = await f.control.command({ type: 'create-project', title, path: join(f.root, title) })
      expect(result.error).toBe('Choose a project name that can be used as a folder name.')
      expect(execute).not.toHaveBeenCalled()
      expect(await readdir(f.root)).not.toContain(title)
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('keeps an explicitly created or selected project open while another project has a queued thread', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Workshop is ready for review.' })
    const created = await f.control.command({ type: 'create-project', title: 'New project', path: join(f.root, 'new-project') })
    const projectId = created.host.projects.find(project => project.title === 'New project')!.id
    expect(created).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    const refreshed = await f.control.command({ type: 'refresh' })
    expect(refreshed).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    await f.control.command({ type: 'next' })
    expect(f.control.get().activeThreadId).toBe('workshop')
    await f.control.command({ type: 'select-project', projectId })
    const selected = await f.control.command({ type: 'refresh' })
    expect(selected).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    expect(selected.queue.some(item => item.threadId === 'workshop')).toBe(true)
    await f.control.command({ type: 'next' })
    await f.control.command({ type: 'compose', text: 'Continue Workshop after review.' })
    await f.control.command({ type: 'select-project', projectId })
    const retained = await f.control.command({ type: 'refresh' })
    expect(retained).toMatchObject({ activeProjectId: projectId, activeThreadId: null,
      draft: 'Continue Workshop after review.', draftThreadId: 'workshop', composing: true })
  })

  it.each(['next', 'later'] as const)('leaves an empty draft when %s moves to another queued thread', async command => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose Workshop colors.', requestId: 'workshop-question' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose Docs colors.', requestId: 'docs-question' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const composing = await f.control.command({ type: 'compose', text: command === 'next' ? '' : '  ' })
    expect(composing.draftRequestId).toBe('workshop-question')
    const moved = await f.control.command({ type: command })
    expect(moved.error).toBeNull()
    expect(moved).toMatchObject({ activeThreadId: 'docs', composing: false, draft: '', draftThreadId: null, draftRequestId: null })
    expect(moved.queue.find(item => item.threadId === 'workshop')?.deferred).toBe(true)
    expect(moved.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
  })

  it('explains reserved queue and thread controls without adding them to an unfinished prompt', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Keep the existing colors.' })
    for (const text of ['Next.', 'Later!', 'Pause managing Workshop', 'Resume managing Workshop', 'Manage Docs', 'Select Docs', 'Open Docs']) {
      const state = await f.control.command({ type: 'utterance', text })
      expect(state.draft).toBe('Keep the existing colors.')
      expect(state.draftThreadId).toBe('workshop')
      expect(state.activeThreadId).toBe('workshop')
      expect(state.error).toMatch(/send or clear your draft/iu)
    }
    const dictated = await f.control.command({ type: 'utterance', text: 'Open the index file and update the heading.' })
    expect(dictated.error).toBeNull()
    expect(dictated.draft).toBe('Keep the existing colors. Open the index file and update the heading.')
    expect(f.requests).toEqual([])
  })

  it('executes an exact thread control after clearing an empty composition', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    const paused = await f.control.command({ type: 'utterance', text: 'Pause managing Workshop.' })
    expect(paused.error).toBeNull()
    expect(paused.composing).toBe(false)
    expect(paused.assignments[0]?.paused).toBe(true)
    const resumed = await f.control.command({ type: 'utterance', text: 'Resume managing Workshop.' })
    expect(resumed.assignments[0]?.paused).toBe(false)
  })

  it('does not dictate an ambiguous exact thread control when titles are duplicated', async () => {
    const f = await fixture()
    await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Docs', modelId: 'claude:test' })
    await f.control.command({ type: 'compose', text: 'Keep this draft.' })
    const state = await f.control.command({ type: 'utterance', text: 'Select Docs' })
    expect(state.draft).toBe('Keep this draft.')
    expect(state.error).toMatch(/send or clear your draft/iu)
    await f.control.command({ type: 'cancel-draft' })
    const ambiguous = await f.control.command({ type: 'utterance', text: 'Select Docs' })
    expect(ambiguous.error).toMatch(/more than one thread/iu)
    expect(f.requests).toEqual([])
  })
})
