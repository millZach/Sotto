import { runFixtureGit } from '../../fixtures/gitRepository'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The status reader holds the index briefly; preserve the journeys' 30 retries and 100ms pauses. */
export function e2eGit(cwd: string, ...args: string[]): string {
  for (let attempt = 0; ; attempt += 1) {
    try { return runFixtureGit(cwd, '-c', 'user.name=Sotto E2E', '-c', 'user.email=e2e@sotto.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args).trim() }
    catch (error) {
      if (attempt >= 30 || !/index\.lock/u.test(error instanceof Error ? error.message : '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

export async function commitFile(repo: string, name: string, text: string): Promise<void> {
  await writeFile(join(repo, name), text)
  e2eGit(repo, 'add', name)
  e2eGit(repo, 'commit', '-q', '-m', `Add ${name}`)
}
