// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { wordPluginChangeInEnglish } from '../../../../src/main/plugins/changeWordsPlain'
import type { PluginChange } from '../../../../src/shared/plugins'

const issue = { owner: 'example-owner', repo: 'example-repo', number: 12 }
const deployment = { account: 'Work', deploymentId: 'dpl_example1' }
const SEND = { plugin: 'Gmail', account: 'Personal', to: ['ann@example.com', 'ben@example.org'], cc: ['cara@example.com'], bcc: ['dan@example.net'], subject: 'October numbers by Friday', text: 'Hello Ann,\n\nThe numbers for October need to reach us by Friday.\n\nThanks,\nZ.' }
const full = { ...deployment, project: 'example-project', projectId: 'prj_example1', target: 'production', url: 'example-project.vercel.app', state: 'READY', teamId: 'team_example1' }

/** Every sentence a card can hold: each kind of change, with and without what is only sometimes known. */
const CHANGES: readonly PluginChange[] = [
  { kind: 'github-comment', ...issue, body: 'Looks good to me.', account: 'example-user' },
  { kind: 'github-comment', ...issue, body: 'Looks good to me.' },
  { kind: 'github-open-issue', owner: 'example-owner', repo: 'example-repo', title: 'A made-up title', body: 'A made-up body.', account: 'example-user' },
  { kind: 'github-open-issue', owner: 'example-owner', repo: 'example-repo', title: 'A made-up title', body: '' },
  { kind: 'github-close-issue', ...issue, title: 'A made-up title', reason: 'completed', account: 'example-user' },
  { kind: 'github-close-issue', ...issue, title: 'A made-up title', reason: 'not_planned' },
  { kind: 'github-reopen-issue', ...issue, title: 'A made-up title', account: 'example-user' },
  { kind: 'github-reopen-issue', ...issue, title: 'A made-up title' },
  { kind: 'vercel-cancel', ...full, target: 'preview', state: 'BUILDING' },
  { kind: 'vercel-cancel', ...deployment },
  { kind: 'vercel-cancel', ...deployment, project: 'example-project' },
  { kind: 'vercel-cancel', ...deployment, projectId: 'prj_example1' },
  { kind: 'vercel-promote', ...full },
  { kind: 'vercel-promote', ...deployment, projectId: 'prj_example1' },
  { kind: 'vercel-rollback', ...full },
  { kind: 'vercel-rollback', ...deployment, projectId: 'prj_example1' },
  { kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code' },
  { kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: '' },
  { kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Codex', watcher: true },
  { kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: '', watcher: true },
  { kind: 'mail-send', ...SEND },
  { kind: 'mail-send', ...SEND, to: ['ann@example.com'], cc: [], bcc: [] },
  { kind: 'mail-send', ...SEND, to: ['ann@example.com'], cc: ['cara@example.com'], bcc: [] },
] as PluginChange[]

it('words a change’s card on a host as the desktop words it in English, sentence for sentence', () => {
  // A headless host cannot load Lingui (ADR-0123), so it has its own English. The two must not drift apart.
  for (const change of CHANGES) expect(wordPluginChangeInEnglish(change), JSON.stringify(change)).toEqual(wordPluginChange(change))
})

it('covers every sentence the desktop’s wording holds', async () => {
  // Each message in the desktop's wording appears in some card above, so a sentence added there fails here until it
  // is given to the host's wording and to the changes this test words.
  const source = await readFile(resolve('src/main/plugins/changeWords.ts'), 'utf8')
  const sentences = [...source.matchAll(/\bt`([^`]*)`/gu)].map(match => match[1]!)
  expect(sentences.length).toBeGreaterThan(40)
  const said = CHANGES.flatMap(change => Object.values(wordPluginChangeInEnglish(change))).join('\n')
  // What a sentence says around its values: the text between one `${...}` and the next.
  const missing = sentences.filter(sentence => !sentence.split(/\$\{[^}]*\}/u).every(part => said.includes(part)))
  expect(missing).toEqual([])
})

it('names Watcher on the card its own mail read waits on, and leaves every other thread’s card as it was', () => {
  // #2565, Zach's pick on November 13, 2026. Watcher is never settled, so its card does not speak of that.
  const watcher = wordPluginChange({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Codex', watcher: true })
  expect(watcher).toEqual({
    plugin: 'Gmail',
    text: 'Let Watcher read the Gmail account Personal? What it reads goes to Codex.',
    action: 'Read Gmail mail',
    target: 'Personal',
    details: ['Watcher can search this account’s mail and read its messages, until you stop it.',
      'What it reads goes to Codex, as everything Watcher reads does.',
      'It cannot send, move or delete mail. Every thread asks for itself.'].join('\n'),
    allow: 'Let Watcher read it',
    deny: 'Don’t allow',
  })
  const unnamed = wordPluginChange({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: '', watcher: true })
  expect(unnamed.text).toBe('Let Watcher read the Gmail account Personal? What it reads goes to Watcher’s provider.')
  expect(unnamed.details.split('\n')[1]).toBe('What it reads goes to Watcher’s provider, as everything Watcher reads does.')
  for (const card of [watcher, unnamed]) expect(JSON.stringify(card)).not.toMatch(/this thread|settled/u)

  const thread = wordPluginChange({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code' })
  expect(thread).toEqual({
    plugin: 'Gmail',
    text: 'Let this thread read the Gmail account Personal? What it reads goes to Claude Code.',
    action: 'Read Gmail mail',
    target: 'Personal',
    details: ['This thread can search this account’s mail and read its messages, until you stop it or the thread is settled.',
      'What it reads goes to Claude Code, as everything a thread reads does.',
      // Zach's words of November 14, 2026 (#2494): reading does not let a thread send, and each email asks.
      'This does not let it send: each email it wants to send asks you first. It cannot move or delete mail. Every other thread asks for itself.'].join('\n'),
    allow: 'Let this thread read it',
    deny: 'Don’t allow',
  })
  expect(wordPluginChange({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code', watcher: false })).toEqual(thread)
})

it('loads nothing of Lingui, which a host cannot run', async () => {
  const source = await readFile(resolve('src/main/plugins/changeWordsPlain.ts'), 'utf8')
  expect(source).not.toMatch(/from '@lingui/u)
})

it('shows everything an email sends on its card, and names the account as the user named it', () => {
  // Zach's picks on November 14, 2026 (#2494), from the mock-up kept as the tag prototype/plugin-mail-send.
  expect(wordPluginChange({ kind: 'mail-send', ...SEND })).toEqual({
    plugin: 'Gmail',
    text: 'Send this email from the Gmail account Personal to ann@example.com, ben@example.org and 2 more?',
    action: 'Send an email as Personal',
    target: 'ann@example.com, ben@example.org and 2 more',
    details: ['To: ann@example.com, ben@example.org', 'Cc: cara@example.com', 'Bcc: dan@example.net', 'Subject: October numbers by Friday', '', SEND.text].join('\n'),
    allow: 'Send the email',
    deny: 'Don’t send it',
  })
  // A line with nobody on it is left off, and one person is named alone.
  const one = wordPluginChange({ kind: 'mail-send', ...SEND, to: ['ann@example.com'], cc: [], bcc: [] })
  expect([one.target, one.details.split('\n').slice(0, 2)]).toEqual(['ann@example.com', ['To: ann@example.com', 'Subject: October numbers by Friday']])
})
