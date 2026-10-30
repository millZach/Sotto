// @vitest-environment node
/**
 * The short-text writing path: text from a side call to the thread's own provider (ADR-0026), the prompts
 * that name a thread and draft commit and pull request text, and the promise that every failure resolves to
 * null instead of an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentHost, ShortTextPrompt, ShortTextPurpose, ThreadLaunchProfiles, WatcherLaunchProfile } from '../../../src/main/agents/host'
import { CodexAppServerHost } from '../../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../../src/main/agents/claude'
import { GrokAcpHost } from '../../../src/main/agents/grok'
import { CursorAcpHost } from '../../../src/main/agents/cursor'
import { WatcherProfileRefusal } from '../../../src/main/agents/watcherProfile'
import * as threadWorktrees from '../../../src/main/agents/threadWorktrees'
import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { nextPromptRequest } from '../../../src/main/llm/nextPrompt'
import { THREAD_TITLE_MAX_CHARACTERS, threadTitleRequest, threadTitleWriter } from '../../../src/main/llm/threadTitle'
import { pullRequestTextWriter } from '../../../src/main/llm/pullRequestText'
import { COMMIT_DIFF_MAX_CHARACTERS, COMMIT_SUBJECT_MAX_CHARACTERS, commitMessageRequest, commitMessageWriter } from '../../../src/main/llm/commitMessage'
import { diffExcerpt } from '../../../src/main/llm/diffExcerpt'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { deferred } from '../../fixtures/deferred'

// The real admission checks run, but reaching the working-directory lookup stops before any side client runs.
// Grok constructs its client before that lookup; keep its constructor from sweeping native session folders.
vi.mock('../../../src/main/agents/subscriptionGrok', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/main/agents/subscriptionGrok')>(),
  GrokSubscriptionClient: class {},
}))

afterEach(() => vi.restoreAllMocks())

const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS }

type SideWrite = (threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal) => Promise<string | null>

function createWriter(write: SideWrite = async () => 'Palette contrast pass') {
  const side = vi.fn(write)
  const failures: string[] = []
  const writer = new ShortTextWriter({ write: side, onFailure: failure => failures.push(`${failure.purpose}:${failure.reason}`) })
  return { side, failures, writer }
}

const sent = (side: ReturnType<typeof vi.fn<SideWrite>>): ShortTextPrompt => side.mock.calls[0]![1]

const exchange = { prompt: 'The palette is unreadable in dark mode.', reply: 'I raised the foreground contrast on the two dark themes.' }

const watcherProfile: WatcherLaunchProfile = {
  kind: 'watcher',
  server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:4321/mcp', headers: [] },
  toolNames: ['list_threads'],
  revoke: () => undefined,
}
const providers = [
  { name: 'Codex', Host: CodexAppServerHost },
  { name: 'Claude', Host: ClaudeStreamJsonHost },
  { name: 'Grok', Host: GrokAcpHost },
  { name: 'Cursor', Host: CursorAcpHost },
]

/** Exercise the adapters' real side-writing and profile checks without starting a provider or opening files. */
function guardedProvider(Host: { prototype: Required<Pick<AgentHost, 'writeShortText'>> }, profile: WatcherLaunchProfile | undefined) {
  const profileFor = vi.fn<ThreadLaunchProfiles['profileFor']>().mockResolvedValue(profile)
  const known = new Map<string, WatcherLaunchProfile>()
  const alias = { kind: 'project', modelId: 'fixture-model', cwd: process.cwd(), grokSessionId: 'grok-session', cursorSessionId: 'cursor-session' }
  const reachedSideCall = new Error('Reached the isolated side call')
  const sideCall = vi.spyOn(threadWorktrees, 'existingWorkingDirectory').mockRejectedValue(reachedSideCall)
  const host = Object.assign(Object.create(Host.prototype) as Required<Pick<AgentHost, 'writeShortText'>>, {
    generation: 0, launchProfiles: { profileFor }, aliases: { watcher: alias }, state: { connected: true, models: [] },
    options: { executable: process.execPath, codexHome: process.cwd() }, userDataDirectory: process.cwd(),
    executable: process.execPath, program: { executable: process.execPath, args: [] },
    runtimes: new Map(), processes: new Map(), connections: new Map(),
    watcherProfiles: known, resolvedWatcherProfiles: known, knownLaunchProfiles: known,
    stopUnverifiedProfile: vi.fn(), stopWatcher: vi.fn(), revokeProfile: vi.fn(),
  })
  return { host, alias, profileFor, known, sideCall, reachedSideCall }
}

describe.each(providers)('$name Watcher side writing', ({ Host }) => {
  it('admits only the internal next-prompt purpose after checking the Watcher profile', async () => {
    const f = guardedProvider(Host, watcherProfile)
    const refused: (ShortTextPurpose | undefined)[] = [undefined, 'thread-title', 'thread-branch', 'commit-message', 'pull-request-text']
    for (const purpose of refused) {
      await expect(f.host.writeShortText('watcher', { instruction: 'Write a line.', material: 'Conversation', ...(purpose ? { purpose } : {}) })).resolves.toBeNull()
    }
    expect(f.profileFor).toHaveBeenCalledTimes(refused.length)
    expect(f.sideCall).not.toHaveBeenCalled()
    await expect(f.host.writeShortText('watcher', nextPromptRequest([exchange]))).rejects.toBe(f.reachedSideCall)
    expect(f.profileFor).toHaveBeenLastCalledWith('watcher')
    expect(f.sideCall).toHaveBeenCalledOnce()
  })

  it.each(['failed', 'invalid', 'revoked'] as const)('refuses next-prompt writing when the profile is %s', async failure => {
    const f = guardedProvider(Host, watcherProfile)
    if (failure === 'failed') f.profileFor.mockRejectedValue(new Error('Profile unavailable'))
    else if (failure === 'invalid') f.profileFor.mockResolvedValue({ ...watcherProfile, server: { ...watcherProfile.server, url: 'https://example.invalid/mcp' } })
    else { f.known.set('watcher', watcherProfile); f.profileFor.mockResolvedValue(undefined) }
    await expect(f.host.writeShortText('watcher', nextPromptRequest([exchange]))).rejects.toBeInstanceOf(WatcherProfileRefusal)
    expect(f.sideCall).not.toHaveBeenCalled()
  })

  it('keeps ordinary thread writing available', async () => {
    const f = guardedProvider(Host, undefined)
    await expect(f.host.writeShortText('watcher', threadTitleRequest(exchange))).rejects.toBe(f.reachedSideCall)
    expect(f.sideCall).toHaveBeenCalledOnce()
  })
})

describe.each(providers.filter(provider => provider.name !== 'Cursor'))('$name personal side writing', ({ Host }) => {
  it('still refuses next-prompt writing for a personal chat', async () => {
    const f = guardedProvider(Host, undefined)
    f.alias.kind = 'personal'
    await expect(f.host.writeShortText('watcher', nextPromptRequest([exchange]))).resolves.toBeNull()
    expect(f.sideCall).not.toHaveBeenCalled()
  })
})

describe('the short-text writing path', () => {
  it('stops a side call in flight, waits for it, and refuses new writing after shutdown', async () => {

    const { promise: started, resolve: entered } = deferred<void>()
    let signal: AbortSignal | undefined
    const { writer, side, failures } = createWriter((_threadId, _prompt, received) => {
      signal = received
      entered()
      // A client started for the call ends only when it is told to stop.
      return new Promise<string | null>((_resolve, reject) => { received!.addEventListener('abort', () => reject(new Error('Client stopped')), { once: true }) })
    })
    const pending = writer.write('thread-a', threadTitleRequest(exchange))
    await started
    await writer.close()
    expect(signal!.aborted).toBe(true)
    await expect(pending).resolves.toBeNull()
    await expect(writer.write('thread-a', threadTitleRequest(exchange))).resolves.toBeNull()
    expect(side).toHaveBeenCalledOnce()
    // A call stopped by shutdown is not a failure worth recording.
    expect(failures).toEqual([])
  })

  it('discards a title that arrives after shutdown has started', async () => {
    let finish!: (value: string) => void
    const { writer } = createWriter(() => { const pending = deferred<string>(); finish = pending.resolve; return pending.promise })
    const pending = writer.write('thread-a', threadTitleRequest(exchange))
    await Promise.resolve()
    const closed = vi.fn()
    const shutdown = writer.close().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    finish('Late title')
    await shutdown
    await expect(pending).resolves.toBeNull()
  })

  it('asks the named thread\'s provider, with the instruction and the material kept apart', async () => {
    const { side, writer } = createWriter()
    await expect(writer.write('thread-a', threadTitleRequest(exchange))).resolves.toBe('Palette contrast pass')
    expect(side).toHaveBeenCalledTimes(1)
    expect(side.mock.calls[0]![0]).toBe('thread-a')
    const prompt = sent(side)
    expect(prompt.instruction).toMatch(/^You name a coding conversation/u)
    expect(prompt.instruction).not.toContain(exchange.prompt)
    expect(prompt.purpose).toBe('thread-title')
    expect(Object.keys(prompt).sort()).toEqual(['instruction', 'material', 'purpose'])
  })

  it('carries the trusted next-prompt purpose to the provider apart from its model prompt', async () => {
    const { side, writer } = createWriter()
    const request = nextPromptRequest([exchange])
    await writer.write('watcher', request)
    expect(sent(side)).toEqual({ instruction: request.instruction, material: request.material, purpose: 'next-prompt' })
  })

  it('carries the first message and the first reply, and nothing else', async () => {
    const { side, writer } = createWriter()
    await writer.write('thread-a', threadTitleRequest(exchange))
    const material = sent(side).material
    expect(material).toContain(exchange.prompt)
    expect(material).toContain(exchange.reply)
    expect(material.replace(exchange.prompt, '').replace(exchange.reply, '').trim()).toBe('First message:\n\n\nFirst reply:')
  })

  it('takes the first line, drops quotes and a trailing period, and cuts an over-long name at a word', async () => {
    const cases: [string, string][] = [
      ['"Palette contrast pass."', 'Palette contrast pass'],
      ['Palette contrast pass\nHere is why I chose it.', 'Palette contrast pass'],
      ['   \n  Palette   contrast  pass  ', 'Palette contrast pass'],
    ]
    for (const [content, expected] of cases) {
      const { writer } = createWriter(async () => content)
      await expect(writer.write('thread-a', threadTitleRequest(exchange))).resolves.toBe(expected)
    }
    const long = createWriter(async () => 'Raise the foreground contrast of every dark theme so the palette can be read again')
    const title = await long.writer.write('thread-a', threadTitleRequest(exchange))
    expect(title!.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_CHARACTERS)
    expect(title).not.toMatch(/\s$/u)
    expect('Raise the foreground contrast of every dark theme so the palette can be read again').toContain(title!)
  })

  it('resolves to null on every failure and logs a stable reason without the text', async () => {
    const unavailable = createWriter(async () => null)
    await expect(unavailable.writer.write('devin-thread', threadTitleRequest(exchange))).resolves.toBeNull()
    expect(unavailable.failures).toEqual(['thread-title:unavailable'])

    const failed = createWriter(() => Promise.reject(new Error(`Claude Code could not write ${exchange.prompt}`)))
    await expect(failed.writer.write('thread-a', threadTitleRequest(exchange))).resolves.toBeNull()
    expect(failed.failures).toEqual(['thread-title:failed'])

    const empty = createWriter(async () => '   ')
    await expect(empty.writer.write('thread-a', threadTitleRequest(exchange))).resolves.toBeNull()
    expect(empty.failures).toEqual(['thread-title:empty'])

    const throwingLog = new ShortTextWriter({ write: async () => null, onFailure: () => { throw new Error('log unavailable') } })
    await expect(throwingLog.write('thread-a', threadTitleRequest(exchange))).resolves.toBeNull()
  })

  it('writes a pull request title and body from the subjects and the capped diff alone', async () => {
    const written = 'Draft the pull request form\n\n## What changed\n\n- The form drafts itself.\n\n\n\n## Test plan\n\n- `npx vitest run`\n'
    const { side, writer } = createWriter(async () => `\`\`\`markdown\n${written}\`\`\``)
    const material = { subjects: ['Draft the form', 'Cap the diff'], diff: 'diff --git a/src/form.ts b/src/form.ts\n+const drafted = true' }
    const draft = pullRequestTextWriter(writer, () => SETTINGS)
    await expect(draft('thread-a', material)).resolves.toEqual({
      title: 'Draft the pull request form',
      body: '## What changed\n\n- The form drafts itself.\n\n## Test plan\n\n- `npx vitest run`',
    })
    expect(side.mock.calls[0]![0]).toBe('thread-a')
    const text = sent(side).material
    for (const subject of material.subjects) expect(text).toContain(subject)
    expect(text).toContain(material.diff)
    // Nothing but the two labels is left once the subjects and the diff are removed.
    const rest = text.replace(material.diff, '').replace(/- .*/gu, '').trim()
    expect(rest).toBe('Commit subjects:\n\n\n\nDiff against the base branch:')
  })

  it('asks for nothing while generated pull request text is off, or when the branch has no commits', async () => {
    const { side, writer } = createWriter()
    const material = { subjects: ['Draft the form'], diff: 'diff' }
    await expect(pullRequestTextWriter(writer, () => ({ ...SETTINGS, pullRequestText: false }))('thread-a', material)).resolves.toBeNull()
    await expect(pullRequestTextWriter(writer, () => SETTINGS)('thread-a', { subjects: [], diff: 'diff' })).resolves.toBeNull()
    expect(side).not.toHaveBeenCalled()
    const unavailable = createWriter(async () => null)
    await expect(pullRequestTextWriter(unavailable.writer, () => SETTINGS)('devin-thread', material)).resolves.toBeNull()
    expect(unavailable.failures).toEqual(['pull-request-text:unavailable'])
  })

  it('asks for nothing while generated titles are off or settings cannot be read', async () => {
    const { side, writer } = createWriter()
    await expect(threadTitleWriter(writer, () => ({ ...SETTINGS, threadTitles: false }))('thread-a', exchange)).resolves.toBeNull()
    await expect(threadTitleWriter(writer, () => { throw new Error('settings unavailable') })('thread-a', exchange)).resolves.toBeNull()
    expect(side).not.toHaveBeenCalled()
    await expect(threadTitleWriter(writer, () => SETTINGS)('thread-a', exchange)).resolves.toBe('Palette contrast pass')
    expect(side).toHaveBeenCalledTimes(1)
  })
})

const excerpt = { text: 'diff --git a/src/app.ts b/src/app.ts\n+export const ready = true\n', truncated: false }

describe('the commit message a staged diff earns', () => {
  it('carries the staged diff alone, and the note when it was cut', async () => {
    const { side, writer } = createWriter(async () => 'Raise the dark palette contrast')
    await expect(commitMessageWriter(writer, () => SETTINGS)('thread-a', excerpt)).resolves.toBe('Raise the dark palette contrast')
    expect(side.mock.calls[0]![0]).toBe('thread-a')
    const material = sent(side).material
    expect(material).toBe(`Staged diff:\n${excerpt.text}`)
    const cut = diffExcerpt('a\n'.repeat(COMMIT_DIFF_MAX_CHARACTERS), COMMIT_DIFF_MAX_CHARACTERS)
    expect(cut).toMatchObject({ truncated: true })
    expect(cut.text.length).toBeLessThanOrEqual(COMMIT_DIFF_MAX_CHARACTERS)
    expect(commitMessageRequest(cut).material).toMatch(/was cut here/u)
  })

  it('keeps a short body, shortens an over-long subject and drops a fence', async () => {
    const fenced = createWriter(async () => '```\nAdd the commit draft to the Changes panel.\n\nThe staged diff is the only material sent.\n```')
    await expect(commitMessageWriter(fenced.writer, () => SETTINGS)('thread-a', excerpt)).resolves
      .toBe('Add the commit draft to the Changes panel\n\nThe staged diff is the only material sent.')
    const long = createWriter(async () => 'Subject: Draft the commit message from the staged diff so the Changes panel opens with words already written')
    const message = await commitMessageWriter(long.writer, () => SETTINGS)('thread-a', excerpt)
    expect(message!.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX_CHARACTERS)
    expect(message).toBe('Draft the commit message from the staged diff so the Changes panel')
  })

  it('asks for nothing while generated commit messages are off, and nothing from a provider that writes nothing', async () => {
    const off = createWriter()
    await expect(commitMessageWriter(off.writer, () => ({ ...SETTINGS, commitMessages: false }))('thread-a', excerpt)).resolves.toBeNull()
    expect(off.side).not.toHaveBeenCalled()
    const unavailable = createWriter(async () => null)
    await expect(commitMessageWriter(unavailable.writer, () => SETTINGS)('devin-thread', excerpt)).resolves.toBeNull()
    expect(unavailable.failures).toEqual(['commit-message:unavailable'])
  })
})

describe('the Commit and pull request style', () => {
  const branch = { subjects: ['Draft the form'], diff: 'diff --git a/x b/x\n+x', template: '## Checklist\n- [ ] Tested' }
  it('adds nothing for the repository\'s own conventions, and the Conventional Commits form when chosen', async () => {
    const repository = createWriter(async () => 'Raise the contrast')
    await commitMessageWriter(repository.writer, () => SETTINGS)('thread-a', excerpt)
    expect(sent(repository.side).instruction).not.toMatch(/Conventional Commits|own instructions/u)
    const conventional = createWriter(async () => 'fix(theme): raise the contrast')
    await expect(commitMessageWriter(conventional.writer, () => ({ ...SETTINGS, gitWritingStyle: 'conventional' }))('thread-a', excerpt)).resolves.toBe('fix(theme): raise the contrast')
    expect(sent(conventional.side).instruction).toMatch(/Conventional Commits form, "type\(scope\): summary"/u)
    // One rule, not two: the chosen style outranks the example, the recent subjects and AGENTS.md on style.
    expect(sent(conventional.side).instruction).toMatch(/takes precedence over the example subject above, the recent commit subjects and anything the repository's AGENTS\.md says about commit message style/u)
    const pullRequest = createWriter(async () => 'feat: draft the form\n\nBody')
    await pullRequestTextWriter(pullRequest.writer, () => ({ ...SETTINGS, gitWritingStyle: 'conventional' }))('thread-a', branch)
    expect(sent(pullRequest.side).instruction).toMatch(/title in the Conventional Commits form[\s\S]*AGENTS\.md says about pull request style/u)
  })
  it('sends the user\'s own instructions in the instruction, never the material, and nothing when none were written', async () => {
    const custom = createWriter(async () => 'Raised the contrast')
    await commitMessageWriter(custom.writer, () => ({ ...SETTINGS, gitWritingStyle: 'custom', gitWritingInstructions: '  Subjects in the past tense.  ' }))('thread-a', excerpt)
    expect(sent(custom.side).instruction).toMatch(/instructions for commit messages follow\. This takes precedence over[\s\S]*AGENTS\.md[\s\S]*\nSubjects in the past tense\.$/u)
    expect(sent(custom.side).material).not.toContain('past tense')
    const blank = createWriter(async () => 'Raise the contrast')
    await commitMessageWriter(blank.writer, () => ({ ...SETTINGS, gitWritingStyle: 'custom', gitWritingInstructions: '   ' }))('thread-a', excerpt)
    expect(sent(blank.side).instruction).toBe(sent(custom.side).instruction.split('\n\n')[0])
  })
  it('fills a template it is given and opens its own sections without one; whether one is read is the Git action\'s to decide', async () => {
    const withTemplate = createWriter(async () => 'Draft the form\n\nBody')
    await pullRequestTextWriter(withTemplate.writer, () => SETTINGS)('thread-a', branch)
    expect(sent(withTemplate.side).material).toContain('## Checklist')
    expect(sent(withTemplate.side).instruction).toMatch(/fills in the pull request template/u)
    const without = createWriter(async () => 'Draft the form\n\nBody')
    await pullRequestTextWriter(without.writer, () => SETTINGS)('thread-a', { ...branch, template: null })
    expect(sent(without.side).material).not.toContain('## Checklist')
    expect(sent(without.side).instruction).toMatch(/opens with a "## What changed" section/u)
  })
})
