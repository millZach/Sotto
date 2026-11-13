// @vitest-environment node
// November 10, 2026 (#2430): forge's headless host runs with PATH /usr/local/bin:/usr/bin:/bin and gh in ~/.local/bin,
// so every pull request read it made failed, its threads linked no pull requests, and Watcher heard nothing of them.
// Sotto now finds gh the way the CLI lookup finds a provider's client (ADR-0036).
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resetCliLookup } from '../../../src/main/agents/cliLookup'
import { resetGhLookup } from '../../../src/main/agents/git/ghCommand'
import { runGitStatusCommand } from '../../../src/main/agents/git/gitStatus'

const kept = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL, MISE_DATA_DIR: process.env.MISE_DATA_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
let root: string | undefined
afterEach(async () => {
  for (const [key, value] of Object.entries(kept)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  resetGhLookup(); resetCliLookup()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.skipIf(process.platform === 'win32')('starts gh from ~/.local/bin for a host whose PATH lacks it', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-gh-lookup-')))
  const bin = join(root, 'home', '.local', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "scripted gh $*"\n')
  await chmod(join(bin, 'gh'), 0o755)
  resetGhLookup(); resetCliLookup()
  // A host started by systemd or a non-interactive SSH shell, with a login shell that adds nothing. Its PATH is an empty
  // folder rather than /usr/bin, where a CI runner's own gh would be found first.
  await mkdir(join(root, 'system-bin'))
  Object.assign(process.env, { PATH: join(root, 'system-bin'), HOME: join(root, 'home'), SHELL: '/bin/false' })
  expect(await runGitStatusCommand(root, 'gh', ['auth', 'status'])).toBe('scripted gh auth status\n')
})

it.skipIf(process.platform === 'win32')('starts gh from the release mise unpacked when ~/.local/bin holds a mise wrapper', async () => {
  // forge on November 13, 2026: ~/.local/bin/gh runs `mise use -g` and then `mise x`, which the lookup passes over, and mise
  // keeps the release one folder down, in installs/gh/latest/gh_2.102.0_linux_amd64/bin. The lookup found no gh, so
  // the host started plain gh on a PATH without it, and forge's threads still linked no pull requests after #2430.
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-gh-lookup-')))
  const home = join(root, 'home'), bin = join(home, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), '#!/bin/bash\nmise use -g --quiet "gh" || exit 1\nexec mise x "gh" -- "gh" "$@"\n')
  await chmod(join(bin, 'gh'), 0o755)
  const installs = join(home, '.local', 'share', 'mise', 'installs', 'gh')
  const release = join(installs, '2.102.0', 'gh_2.102.0_linux_amd64', 'bin')
  await mkdir(release, { recursive: true })
  await writeFile(join(release, 'gh'), '#!/bin/sh\necho "released gh $*"\n')
  await chmod(join(release, 'gh'), 0o755)
  await symlink('./2.102.0', join(installs, 'latest'))
  resetGhLookup(); resetCliLookup()
  await mkdir(join(root, 'system-bin'))
  // mise's data folder is the home's, not one this machine's own environment names.
  delete process.env.MISE_DATA_DIR; delete process.env.XDG_DATA_HOME
  Object.assign(process.env, { PATH: join(root, 'system-bin'), HOME: home, SHELL: '/bin/false' })
  expect(await runGitStatusCommand(root, 'gh', ['auth', 'status'])).toBe('released gh auth status\n')
})
