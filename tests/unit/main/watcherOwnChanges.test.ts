// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { watcherOwnChanges, annotateWatcherOwnChanges, watcherReplyAsShown, watcherRepliesAsShown } from '../../../src/main/agents/watcherOwnChanges'
import { WATCHER_PULL_REQUEST_NEWS_PROMPT, WATCHER_SYSTEM_PROMPT, watcherSystemPrompt } from '../../../src/main/agents/watcherPrompt'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { mergeAgentActivities, type AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../../src/shared/agents'

const at = '2026-10-13T00:00:00.000Z'
const message = (id: string, role: AgentMessage['role'], text = 'Reply'): AgentMessage => ({ id, role, text, createdAt: at })
const thread = (): AgentThread => ({ id: 'watcher', projectId: 'p', title: 'Watcher', modelId: 'fixture', kind: 'watcher', status: 'idle', requests: [],
  workingDirectory: '/project', messages: [message('user', 'user'), message('reply', 'assistant')], activities: [] })
const change = (id = 'change', turnId = 'user', paths = ['src/a.ts']): AgentActivity => ({ id, turnId, sequence: 0,
  afterMessageId: 'user', kind: 'file-change', title: 'File changes', status: 'completed', changes: paths.map(path => ({ path, kind: 'edit' })) })

describe('Watcher own changes', () => {
  it('has a watched thread end its turn on a pushed pull request and Watcher act on its checks news', () => {
    expect(WATCHER_PULL_REQUEST_NEWS_PROMPT).toContain('A watched thread that pushed to a pull request ends its turn instead of watching CI itself')
    expect(WATCHER_PULL_REQUEST_NEWS_PROMPT).toContain('once any check fails, before the rest finish')
    expect(WATCHER_PULL_REQUEST_NEWS_PROMPT).toContain('When the required checks pass, send it to merge')
    // Only while that news runs (Restart stopped threads); without it nothing would tell Watcher a check failed.
    expect(watcherSystemPrompt(false, false, true)).toContain(WATCHER_PULL_REQUEST_NEWS_PROMPT)
    expect(watcherSystemPrompt(true, true)).not.toContain(WATCHER_PULL_REQUEST_NEWS_PROMPT)
  })

  it('has no mark for missing threads, unproved paths, shell output or a dirty checkout', () => {
    expect(watcherOwnChanges(undefined)).toEqual([])
    const t = thread()
    t.activities = [{ ...change(), kind: 'command', command: 'edit src/a.ts', output: 'Changed src/a.ts' },
      { ...change('no-path'), changes: [] }, { ...change('tool'), kind: 'tool', text: '{"file_path":"src/a.ts"}' },
      change('invalid', 'user', ['', ' ', '.', '..', '/', 'folder/', 'bad\npath', 'x'.repeat(4_097)])]
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it.each(['running', 'unknown', 'failed', 'interrupted'] as const)('never treats %s edits as successful', status => {
    const t = thread(); t.activities = [{ ...change(), status }]
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it('excludes explicit tool errors and unsuccessful exit codes even if a tool says completed', () => {
    const t = thread(); t.activities = [{ ...change(), error: 'Failed' }, { ...change('exit'), exitCode: 1 }]
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it('extracts completed Codex patches and attributes native turn IDs by their user anchors', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.anchor(t, 'codex-turn', 'user')
    projection.item(t, codexItemSchema.parse({ id: 'patch', type: 'fileChange', status: 'completed',
      changes: [{ path: '/project/src/a.ts', kind: { type: 'update' }, diff: 'Patch' }, { path: '/project/src/b.ts', kind: { type: 'add' } }] }),
    { turnId: 'codex-turn', phase: 'completed', afterMessageId: 'user' })
    projection.turn(t, { id: 'codex-turn', status: 'completed' })
    expect(watcherOwnChanges(t)).toEqual([{ replyMessageId: 'reply', turnId: 'codex-turn', files: ['/project/src/a.ts', '/project/src/b.ts'],
      fileCount: 2, reason: null, source: 'provider-file-change' }])
  })

  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('extracts acknowledged Claude %s changes', name => {
    const t = thread(); const projection = new ClaudeActivity()
    const input = name === 'NotebookEdit' ? { notebook_path: '/project/book.ipynb' } : { file_path: '/project/src/a.ts' }
    t.activities = projection.apply([], { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit', name, input }] } }, 'user', 'user', '/project')
    expect(watcherOwnChanges(t)).toEqual([])
    t.activities = projection.apply(t.activities, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Done', is_error: false }] } }, 'user', 'reply', '/project')
    expect(watcherOwnChanges(t)[0]).toMatchObject({ replyMessageId: 'reply', files: [name === 'NotebookEdit' ? '/project/book.ipynb' : '/project/src/a.ts'], fileCount: 1 })
    const failed = thread()
    failed.activities = projection.apply(t.activities, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Failed', is_error: true }] } }, 'user', 'reply', '/project')
    expect(watcherOwnChanges(failed)).toEqual([])
  })

  it('extracts Grok diff and location paths only once a file tool finishes', () => {
    const t = thread(); const context = { turnId: 'user', afterMessageId: 'user', cwd: '/project' }
    const started = grokActivities({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'in_progress',
      content: [{ type: 'diff', path: '/project/src/a.ts', oldText: 'a', newText: 'b' }] }, context)
    t.activities = started; expect(watcherOwnChanges(t)).toEqual([])
    const ended = grokActivities({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' }, context, started)
    t.activities = mergeAgentActivities(started, ended)
    t.activities = mergeAgentActivities(t.activities, grokActivities({ sessionUpdate: 'tool_call', toolCallId: 'delete', kind: 'delete', status: 'completed',
      locations: [{ path: '/project/src/b.ts' }] }, context, t.activities))
    t.activities = mergeAgentActivities(t.activities, grokActivities({ sessionUpdate: 'tool_call', toolCallId: 'failed', kind: 'edit', status: 'failed',
      locations: [{ path: '/project/failed.ts' }] }, context, t.activities))
    expect(watcherOwnChanges(t)[0]).toMatchObject({ files: ['/project/src/a.ts', '/project/src/b.ts'], fileCount: 2 })
  })

  it('deduplicates equivalent paths and repeated patches without counting hunks', () => {
    const t = thread(); t.activities = [change('one', 'user', ['src/a.ts', './src/a.ts', '/project/src/a.ts']), change('two', 'user', ['src/a.ts', 'src/b.ts'])]
    expect(watcherOwnChanges(t)[0]).toMatchObject({ files: ['/project/src/a.ts', '/project/src/b.ts'], fileCount: 2 })
    t.workingDirectory = 'D:\\project'
    t.activities = [change('windows', 'user', ['src\\A.ts', 'D:/project/src/a.ts', '.\\src\\A.ts'])]
    expect(watcherOwnChanges(t)[0]).toMatchObject({ files: ['D:\\project\\src\\A.ts'], fileCount: 1 })
  })

  it('keeps old and new turns attached to their own final replies', () => {
    const t = thread()
    t.messages = [message('user', 'user'), message('commentary', 'assistant'), message('reply', 'assistant', 'Watcher change reason: First'),
      message('next-user', 'user'), message('next-reply', 'assistant', 'Watcher change reason: Second')]
    t.activities = [change(), { ...change('next', 'next-user', ['src/b.ts']), afterMessageId: 'next-user' }]
    expect(watcherOwnChanges(t).map(mark => [mark.replyMessageId, mark.files, mark.reason])).toEqual([
      ['reply', ['/project/src/a.ts'], 'First'], ['next-reply', ['/project/src/b.ts'], 'Second'],
    ])
  })

  it('uses an explicit Codex turn anchor over a late activity anchored after a newer user send', () => {
    const t = thread(); t.messages.push(message('next-user', 'user'), message('next-reply', 'assistant'))
    t.activities = [{ ...change('late', 'native-turn'), afterMessageId: 'next-user' },
      { id: 'turn', turnId: 'native-turn', sequence: 1, kind: 'turn', status: 'completed', title: 'Completed', afterMessageId: 'user' }]
    expect(watcherOwnChanges(t)[0]?.replyMessageId).toBe('reply')
  })

  it('marks edits made before a steer when the final reply still belongs to the same native turn', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    t.messages = [message('user', 'user'), message('steer', 'user', 'Change direction'), message('reply', 'assistant', 'Watcher change reason: Needed.')]
    projection.anchor(t, 'native-turn', 'user')
    projection.item(t, codexItemSchema.parse({ id: 'patch', type: 'fileChange', status: 'completed',
      changes: [{ path: '/project/src/a.ts', kind: { type: 'update' } }] }), { turnId: 'native-turn', afterMessageId: 'user', phase: 'completed' })
    projection.turn(t, { id: 'native-turn', status: 'completed' })
    t.lastTurn = { id: 'native-turn', status: 'completed' }
    expect(watcherOwnChanges(t)).toEqual([{ replyMessageId: 'reply', turnId: 'native-turn', files: ['/project/src/a.ts'],
      fileCount: 1, reason: 'Needed.', source: 'provider-file-change' }])
  })

  it('keeps a later explicitly anchored turn outside the current terminal turn scan', () => {
    const t = thread()
    t.messages = [message('user', 'user'), message('steer', 'user'), message('reply', 'assistant'), message('later-user', 'user'), message('later-reply', 'assistant')]
    t.activities = [change('patch', 'native-turn'),
      { id: 'original-turn', turnId: 'native-turn', sequence: 1, kind: 'turn', status: 'completed', title: 'Completed', afterMessageId: 'user' },
      { id: 'later-turn', turnId: 'other-turn', sequence: 2, kind: 'turn', status: 'completed', title: 'Completed', afterMessageId: 'later-user' }]
    t.lastTurn = { id: 'native-turn', status: 'completed' }
    expect(watcherOwnChanges(t)[0]?.replyMessageId).toBe('reply')
  })

  it('keeps retained later turn anchors as reply boundaries after activity eviction', () => {
    const t = thread()
    t.messages = [{ ...message('user', 'user'), watcherObservedChanges: [{ turnId: 'original-native-turn', files: ['/project/old.ts'] }] },
      message('steer', 'user'), message('reply', 'assistant', 'Watcher change reason: Original'),
      { ...message('later-user', 'user'), watcherObservedChanges: [{ turnId: 'later-native-turn', files: ['/project/later.ts'] }] },
      message('later-reply', 'assistant', 'Watcher change reason: Later')]
    t.activities = [{ id: 'later-turn', turnId: 'later-native-turn', sequence: 0, kind: 'turn', status: 'completed', title: 'Completed', afterMessageId: 'later-user' }]
    t.lastTurn = { id: 'original-native-turn', status: 'completed' }
    const expected = [['reply', 'original-native-turn', ['/project/old.ts'], 'Original'], ['later-reply', 'later-native-turn', ['/project/later.ts'], 'Later']]
    const marks = () => watcherOwnChanges(t).map(mark => [mark.replyMessageId, mark.turnId, mark.files, mark.reason])
    expect(marks()).toEqual(expected)
    t.activities = []
    expect(marks()).toEqual(expected)
  })

  it('uses the normalized Sotto origin of a completed Claude turn to cross a folded steer', () => {
    const t = thread()
    t.messages = [message('user', 'user'), message('steer', 'user'), message('reply', 'assistant')]
    t.activities = [change(), { id: 'original-turn', turnId: 'user', sequence: 1, kind: 'turn', status: 'completed', title: 'Completed', afterMessageId: 'user' }]
    t.lastTurn = { id: 'claude-native-origin', messageId: 'user', status: 'completed' }
    expect(watcherOwnChanges(t)[0]).toMatchObject({ replyMessageId: 'reply', turnId: 'user', files: ['/project/src/a.ts'] })
  })

  it('keeps staged file evidence on the original turn after tool eviction and a same-turn steer', () => {
    const t = thread()
    t.messages = [message('user', 'user'), message('steer', 'user'), message('reply', 'assistant')]
    t.messages[0]!.watcherObservedChanges = [{ turnId: 'user', files: ['/project/src/a.ts', '/project/src/b.ts'] }]
    t.activities = []
    t.lastTurn = { id: 'claude-native-origin', messageId: 'user', status: 'running' }
    expect(watcherOwnChanges(t)).toEqual([])
    t.lastTurn.status = 'completed'
    expect(watcherOwnChanges(t)[0]).toMatchObject({ replyMessageId: 'reply', turnId: 'user', files: ['/project/src/a.ts', '/project/src/b.ts'], fileCount: 2 })
  })

  it('requires an available unambiguous anchor and an assistant reply', () => {
    const t = thread(); t.activities = [{ ...change('missing', 'other-turn'), afterMessageId: 'missing' }]
    expect(watcherOwnChanges(t)).toEqual([])
    t.activities = [{ ...change('anchor', 'native-turn'), afterMessageId: 'reply' }]
    expect(watcherOwnChanges(t)[0]?.replyMessageId).toBe('reply')
    t.messages.push(message('next-user', 'user'), message('next-reply', 'assistant'))
    t.activities.push({ ...change('conflict', 'native-turn'), afterMessageId: 'next-reply' })
    expect(watcherOwnChanges(t)).toEqual([])
    t.messages = [message('user', 'user')]; t.activities = [change()]
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it('waits for a running turn to finish before marking its final reply', () => {
    const t = thread(); t.activities = [change()]; t.lastTurn = { id: 'user', status: 'running' }
    expect(watcherOwnChanges(t)).toEqual([])
    t.lastTurn.status = 'completed'
    expect(watcherOwnChanges(t)).toHaveLength(1)
    t.activities.push({ id: 'turn', turnId: 'user', sequence: 1, kind: 'turn', status: 'running', title: 'Working', afterMessageId: 'user' })
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it.each([
    ['Watcher change reason: Needed to restore the thread.', 'Needed to restore the thread.'],
    ['Before\r\nWatcher change reason: Needed.\r\nAfter', 'Needed.'],
    ['Watcher change reason: ' + 'x'.repeat(2_000), 'x'.repeat(2_000)],
    ['I did this because it was needed.', null],
    ['Because: Watcher change reason: Needed.', null],
    [' Watcher change reason: Needed.', null],
    ['- Watcher change reason: Needed.', null],
    ['> Watcher change reason: Needed.', null],
    ['watcher change reason: Needed.', null],
    ['Watcher change reason:Needed.', 'Needed.'],
    ['Watcher change reason: ', null],
    ['Watcher change reason:   ', null],
    ['Watcher change reason: ' + 'x'.repeat(2_001), 'x'.repeat(1_999) + '…'],
    ['Watcher change reason: One\nWatcher change reason: Two', null],
    ['Watcher change reason: One\nWatcher change reason:', null],
    ['```text\nWatcher change reason: An example\n```', null],
    ['~~~\nWatcher change reason: An example\n~~~', null],
  ])('reads only one whole reply line, trimming and shortening its reason: %s', (text, reason) => {
    const t = thread(); t.messages[1]!.text = text; t.activities = [change()]
    expect(watcherOwnChanges(t)[0]?.reason).toBe(reason)
  })

  it('retains history-owned marks after activity eviction and augments without losing older files', () => {
    const t = thread(); t.activities = [change()]
    t.messages = annotateWatcherOwnChanges(t)
    const marked = t.messages[1]!
    t.activities = []
    expect(watcherOwnChanges(t)[0]).toEqual(marked.watcherOwnChange)
    expect(annotateWatcherOwnChanges(t)[1]).toBe(marked)
    t.activities = [change('new', 'user', ['src/b.ts'])]
    expect(watcherOwnChanges(t)[0]).toMatchObject({ files: ['/project/src/a.ts', '/project/src/b.ts'], fileCount: 2 })
    expect(t.messages[1]).toBe(marked)
  })

  it('does not project a retained mark on a user or a different reply ID', () => {
    const t = thread(); t.activities = [change()]; const mark = watcherOwnChanges(t)[0]!
    t.activities = []; t.messages[0]!.watcherOwnChange = mark
    t.messages[1]!.watcherOwnChange = { ...mark, replyMessageId: 'other' }
    expect(watcherOwnChanges(t)).toEqual([])
  })

  it('stages successful edits on the exact user message before a running turn has any reply', () => {
    const t = thread(); t.messages = [message('user', 'user')]; t.lastTurn = { id: 'native-turn', status: 'running' }
    t.activities = [{ ...change('early', 'native-turn'), afterMessageId: 'user' },
      { ...change('failed', 'native-turn', ['failed.ts']), status: 'failed' },
      { ...change('pending', 'native-turn', ['pending.ts']), status: 'running' }]
    t.messages = annotateWatcherOwnChanges(t)
    expect(t.messages[0]?.watcherObservedChanges).toEqual([{ turnId: 'native-turn', files: ['/project/src/a.ts'] }])
    expect(watcherOwnChanges(t)).toEqual([])
    t.activities = []
    t.messages.push(message('reply', 'assistant', 'Watcher change reason: Needed.'))
    t.lastTurn.status = 'completed'
    expect(watcherOwnChanges(t)[0]).toMatchObject({ replyMessageId: 'reply', turnId: 'native-turn', files: ['/project/src/a.ts'], reason: 'Needed.' })
  })

  it('retains distinct cwd-qualified files with the same relative basename', () => {
    const t = thread(); t.messages = [message('user', 'user')]; t.lastTurn = { id: 'user', status: 'running' }
    t.activities = [{ ...change('one', 'user', ['same.ts']), cwd: '/project/one' }, { ...change('two', 'user', ['same.ts']), cwd: '/project/two' }]
    t.messages = annotateWatcherOwnChanges(t); t.activities = []
    t.messages.push(message('reply', 'assistant')); t.lastTurn.status = 'completed'
    expect(watcherOwnChanges(t)[0]).toMatchObject({ files: ['/project/one/same.ts', '/project/two/same.ts'], fileCount: 2 })
  })

  it('keeps staged older and newer turns separate after their tool evidence expires', () => {
    const t = thread()
    t.messages[0]!.watcherObservedChanges = [{ turnId: 'old-native-turn', files: ['/project/old.ts'] }]
    t.messages.push({ ...message('next-user', 'user'), watcherObservedChanges: [{ turnId: 'next-native-turn', files: ['/project/next.ts'] }] }, message('next-reply', 'assistant'))
    expect(watcherOwnChanges(t).map(mark => [mark.replyMessageId, mark.files])).toEqual([['reply', ['/project/old.ts']], ['next-reply', ['/project/next.ts']]])
  })

  it('instructs Watcher to delegate changes, state the defined reason, manage watches and leave cards to the user', () => {
    expect(WATCHER_SYSTEM_PROMPT).toContain('Do not edit project files or run commands that change things yourself.')
    expect(WATCHER_SYSTEM_PROMPT).toContain('Watcher change reason: <reason>')
    expect(WATCHER_SYSTEM_PROMPT).toContain('watch_thread and unwatch_thread')
    expect(WATCHER_SYSTEM_PROMPT).toContain('watch each active thread')
    expect(WATCHER_SYSTEM_PROMPT).toContain('Ping the user only')
    expect(WATCHER_SYSTEM_PROMPT).toContain('Never try to answer')
  })

  it.each([
    ['I fixed it.\nWatcher change reason: Needed.', 'I fixed it.'],
    ['I fixed it.\n\nWatcher change reason: Needed.', 'I fixed it.'],
    ['I fixed it.\r\n\r\nWatcher change reason: Needed.\r\n\r\nThen I told the worker.', 'I fixed it.\r\n\r\nThen I told the worker.'],
    ['Watcher change reason: Needed.\nI fixed it.', 'I fixed it.'],
    ['I fixed it.\nWatcher change reason:Needed.', 'I fixed it.'],
    ['I fixed it.\nWatcher change reason:   Needed.   ', 'I fixed it.'],
    ['Watcher change reason: Needed.\n\nI fixed it.', 'I fixed it.'],
    ['Watcher change reason: Needed.\r\n\r\nI fixed it.\r\n\r\nThen I told the worker.', 'I fixed it.\r\n\r\nThen I told the worker.'],
    ['I fixed it.\nWatcher change reason: Needed.\nThen I told the worker.', 'I fixed it.\nThen I told the worker.'],
    ['I fixed it.  \n\n```text\nWatcher change reason: An example\n```\nWatcher change reason: Needed.\n',
      'I fixed it.  \n\n```text\nWatcher change reason: An example\n```\n'],
  ])('shows the reply without the reason line its own-change line shows: %j', (text, shown) => {
    const t = thread(); t.messages[1]!.text = text; t.activities = [change()]
    t.messages = annotateWatcherOwnChanges(t)
    expect(t.messages[1]!.watcherOwnChange?.reason).toMatch(/^Needed\.$/)
    expect(watcherReplyAsShown(t.messages[1]!)).toBe(shown)
  })

  it('hides a reason line that runs long, and keeps its reason shortened', () => {
    const t = thread(); t.messages[1]!.text = `I fixed it.\nWatcher change reason: ${'x'.repeat(2_500)}`; t.activities = [change()]
    t.messages = annotateWatcherOwnChanges(t)
    expect(t.messages[1]!.watcherOwnChange?.reason).toBe('x'.repeat(1_999) + '…')
    expect(watcherReplyAsShown(t.messages[1]!)).toBe('I fixed it.')
  })

  it('hides an empty reason line, which gave no reason', () => {
    const t = thread(); t.messages[1]!.text = 'I fixed it.\nWatcher change reason:'; t.activities = [change()]
    t.messages = annotateWatcherOwnChanges(t)
    expect(t.messages[1]!.watcherOwnChange?.reason).toBeNull()
    expect(watcherReplyAsShown(t.messages[1]!)).toBe('I fixed it.')
  })

  it.each([
    ['no own change', 'I looked.\nWatcher change reason: Needed.', false],
    ['an unread reason', 'I fixed it.\nWatcher change reason: One\nWatcher change reason: Two', true],
    ['a lookalike line', 'I fixed it.\n- Watcher change reason: Needed.', true],
    ['only the reason line', 'Watcher change reason: Needed.', true],
  ])('leaves a reply as written with %s', (_, text, changed) => {
    const t = thread(); t.messages[1]!.text = text; t.activities = changed ? [change()] : []
    t.messages = annotateWatcherOwnChanges(t)
    expect(watcherReplyAsShown(t.messages[1]!)).toBe(text)
  })

  it('takes the reason line off Watcher replies in the shown snapshot only, keeping the reason on the mark', () => {
    const t = thread(); t.messages[0]!.text = 'Watcher change reason: The user typed this.'
    t.messages[1]!.text = 'I fixed it.\nWatcher change reason: Needed.'; t.activities = [change()]
    t.messages = annotateWatcherOwnChanges(t)
    const worker: AgentThread = { ...t, id: 'worker', kind: 'project' }
    const snapshot = { threads: [t, worker] } as unknown as AgentHostSnapshot
    const shown = watcherRepliesAsShown(snapshot)
    const room = shown.threads[0]!
    expect(room.messages.map(item => item.text)).toEqual(['Watcher change reason: The user typed this.', 'I fixed it.'])
    expect(shown.threads[1]).toBe(worker)
    // The mark still reads its reason once the line is off, and showing the shown snapshot again changes nothing.
    expect(watcherOwnChanges(room)[0]?.reason).toBe('Needed.')
    expect(watcherRepliesAsShown(shown).threads[0]!.messages[1]!.text).toBe('I fixed it.')
    expect(watcherRepliesAsShown(snapshot).threads[0]!.messages[1]).toBe(room.messages[1])
    expect(t.messages[1]!.text).toBe('I fixed it.\nWatcher change reason: Needed.')
  })

  it('describes the reason line exactly as Sotto reads it', () => {
    // The prompt's own example, filled in as it says, is the line the room and the phone show as Watcher's reason.
    const example = /^.*: (Watcher change reason: <reason>)$/mu.exec(WATCHER_SYSTEM_PROMPT)?.[1]
    expect(example).toBe('Watcher change reason: <reason>')
    const t = thread(); t.messages[1]!.text = `I fixed the typo myself.\n${example!.replace('<reason>', 'A one-word typo.')}`; t.activities = [change()]
    expect(watcherOwnChanges(t)[0]?.reason).toBe('A one-word typo.')
    // And it rules out each form Sotto does not read: a second line, anything before it, a fence, list or quote, a longer reason.
    for (const rule of ['Give the reason once', 'with nothing before it', 'not in a code block, list or quote', 'on that one line, at most 2,000 characters']) {
      expect(WATCHER_SYSTEM_PROMPT).toContain(rule)
    }
  })
})
