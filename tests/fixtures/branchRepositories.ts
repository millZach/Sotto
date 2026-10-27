import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Git run in a test repository as a fixed author, its output trimmed. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Sotto test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Sotto test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim()
}

export async function commitFile(cwd: string, name: string, content: string | Buffer, message = 'Change ' + name): Promise<string> {
  await writeFile(join(cwd, name), content)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** Random bytes Git cannot compress, so a bundle carrying them is at least this large. */
export const incompressible = (bytes: number): Buffer => randomBytes(bytes)

/**
 * Two clones of one project, as the laptop and forge each keep one: `laptop` and `forge` share `main`'s history, each with
 * `main` checked out, and each has a data folder of Sotto's own for staging and records.
 */
export async function twoMachines() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-branch-moves-'))
  const laptop = join(root, 'laptop'), forge = join(root, 'forge')
  git(root, 'init', '-q', laptop)
  await commitFile(laptop, 'README.md', '# Project\n', 'Start the project')
  await commitFile(laptop, 'app.txt', 'one\n', 'Add the app')
  git(root, 'clone', '-q', laptop, forge)
  // Each clone has an identity of its own, so a commit Sotto's Git makes never rests on this machine's global user.name.
  for (const repository of [laptop, forge]) { git(repository, 'config', 'user.name', 'Sotto test'); git(repository, 'config', 'user.email', 'test@example.invalid') }
  return {
    root, laptop, forge,
    data: (machine: 'laptop' | 'forge') => ({ stagingDirectory: join(root, machine + '-data', 'branch-moves'), recordsPath: join(root, machine + '-data', 'branch-moves.json') }),
    /** What a move must leave alone: the checked-out branch, its commit, the index and working tree, and every branch. */
    untouched: (repository: string) => ({ head: git(repository, 'symbolic-ref', 'HEAD'), commit: git(repository, 'rev-parse', 'HEAD'),
      status: git(repository, 'status', '--porcelain'), branches: git(repository, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') }),
    close: () => dirname(root) === tmpdir() ? rm(root, { recursive: true, force: true }) : Promise.resolve(),
  }
}
