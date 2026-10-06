// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

it('keeps generated hand-test and iOS delivery bundles out of Git and lint', async () => {
  const paths = [
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
