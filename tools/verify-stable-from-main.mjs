// Verify unmerged release tools against an owned clean-main source: node tools/verify-stable-from-main.mjs <checkout> <check|package|finish>
// Builds and checks only. Never installs, uploads or publishes.
import { resolve } from 'node:path'
import process from 'node:process'
import { checkRelease } from '../scripts/check-release.mjs'
import { packageStable } from '../scripts/package-stable.mjs'
import { releaseLinux } from '../scripts/release-linux.mjs'

const [directory, stage, ...extra] = process.argv.slice(2)
if (!directory || extra.length || !['check', 'package', 'finish'].includes(stage)) {
  throw new Error('Usage: node tools/verify-stable-from-main.mjs <owned clean-main checkout> <check|package|finish>')
}
const root = resolve(directory)
if (stage === 'check') await checkRelease({ root })
if (stage === 'package') await packageStable('linux', [], root)
if (stage === 'finish') await releaseLinux([], root)
