// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { wordPluginChangeInEnglish } from '../../../../src/main/plugins/changeWordsPlain'
import type { PluginChange } from '../../../../src/shared/plugins'

const issue = { owner: 'example-owner', repo: 'example-repo', number: 12 }
const deployment = { account: 'Work', deploymentId: 'dpl_example1' }
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
      'It cannot send, move or delete mail. Every other thread asks for itself.'].join('\n'),
    allow: 'Let this thread read it',
    deny: 'Don’t allow',
  })
  expect(wordPluginChange({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code', watcher: false })).toEqual(thread)
})

it('loads nothing of Lingui, which a host cannot run', async () => {
  const source = await readFile(resolve('src/main/plugins/changeWordsPlain.ts'), 'utf8')
  expect(source).not.toMatch(/from '@lingui/u)
})
