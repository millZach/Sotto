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

it('loads nothing of Lingui, which a host cannot run', async () => {
  const source = await readFile(resolve('src/main/plugins/changeWordsPlain.ts'), 'utf8')
  expect(source).not.toMatch(/from '@lingui/u)
})
