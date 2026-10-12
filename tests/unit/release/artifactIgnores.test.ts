// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

// The first ignore check loads the real TypeScript ESLint configuration. Like the Git child,
// that setup can exceed the default deadline on a busy runner; elapsed time is not the assertion.
it('keeps generated hand-test and iOS delivery bundles out of Git and lint', { timeout: 60_000 }, async () => {
  const paths = [
    'artifacts/e2e-runs/verification/phase-1-appearance/capture.js',
    'artifacts/forge-hand-test/capture.js',
    'artifacts/review-ios-focus-delivery/capture.js',
    'artifacts/review-ios-settings-delivery/capture.js',
  ]
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: paths.join('\n'), encoding: 'utf8',
  }).trim().split('\n')
  expect(ignored).toEqual(paths)
  const eslint = new ESLint()
  for (const path of paths) expect(await eslint.isPathIgnored(path), path).toBe(true)
})

it('keeps what a Watcher room run writes out of Git and lint, except the evidence its verification note cites', { timeout: 60_000 }, async () => {
  const note = readFileSync('docs/verification/2026-10-11-watcher-room.md', 'utf8')
  const cited = [...new Set(note.match(/artifacts\/watcher-room\/[\w.-]+/gu) ?? [])].sort()
  expect(cited.length).toBeGreaterThan(0)
  const generated = ['artifacts/watcher-room/room-sotto-dark-1280x800-retake.png', 'artifacts/watcher-room/readings-local.json', 'artifacts/watcher-room/capture.js']
  // `--no-index` checks tracked files against the patterns too, so a cited file stays only through its own exception.
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: [...generated, ...cited].join('\n'), encoding: 'utf8',
  }).trim().split('\n')
  expect(ignored).toEqual(generated)
  const eslint = new ESLint()
  for (const path of generated) expect(await eslint.isPathIgnored(path), path).toBe(true)
})
