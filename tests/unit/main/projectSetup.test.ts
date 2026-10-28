// @vitest-environment node
// #1690: a machine with no copy of a start's project gets one, from a clone already in its projects folder or a new one.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGitStatusCommand } from '../../../src/main/agents/gitStatus'
import { ProjectCopies, type ProjectSetupOptions } from '../../../src/main/agents/projectSetup'
import { projectSetupRequestSchema } from '../../../src/shared/workerMachine'

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['-c', 'user.name=Sotto test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd })).stdout.trim()
const repository = { host: 'github.com', owner: 'o', name: 'Sotto' }
const GITHUB_URL = 'https://github.com/o/Sotto.git'
const exists = (path: string) => stat(path).then(() => true, () => false)

let root: string, origin: string, seed: string, home: string, projects: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-setup-'))
  origin = join(root, 'origin.git'); seed = join(root, 'seed'); home = join(root, 'home'); projects = join(home, 'Projects')
  await mkdir(projects, { recursive: true })
  // GitHub stands in as a bare repository with one commit on main.
  await git(root, 'init', '-q', '--bare', origin)
  await git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(root, 'init', '-q', seed)
  await writeFile(join(seed, 'README.md'), '# Sotto\n')
  await git(seed, 'add', 'README.md'); await git(seed, 'commit', '-q', '-m', 'Start')
  await git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main')
})
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5 }) })

/** A new commit on GitHub's main that a copy made before it lacks. */
async function moveGitHubOn(): Promise<string> {
  await writeFile(join(seed, 'NEW.md'), 'new\n')
  await git(seed, 'add', 'NEW.md'); await git(seed, 'commit', '-q', '-m', 'Move on')
  await git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main')
  return git(seed, 'rev-parse', 'HEAD')
}
/** A clone the user made themselves, whose origin names GitHub while its fetches reach the stand-in. */
async function userClone(name: string): Promise<string> {
  const path = join(projects, name)
  await git(root, 'clone', '-q', origin, path)
  await git(path, 'remote', 'set-url', 'origin', GITHUB_URL)
  await git(path, 'config', `url.${origin}.insteadOf`, GITHUB_URL)
  return path
}
function copies(patch: Partial<ProjectSetupOptions> = {}) {
  const addProject = vi.fn(async (_title: string, path: string) => `project:${path}`)
  const setup = new ProjectCopies({ projects: () => [{ path: join(projects, 'Notes') }, { path: join(projects, 'Other') }, { path: home }, { path: join(root, 'elsewhere', 'One') }],
    projectsDirectory: () => '', home, ownFolder: join(root, 'sotto-data'), addProject, cloneUrl: () => origin, ...patch })
  return { setup, addProject }
}

describe('setting up a copy of a project (#1690)', () => {
  it('adds a clone already in the usual projects folder and fast-forwards its clean default branch', async () => {
    const path = await userClone('sotto-checkout')
    const newest = await moveGitHubOn()
    const { setup, addProject } = copies()
    expect(await setup.setUp({ repository, title: 'Sotto' })).toEqual({ ok: true, projectId: `project:${path}`, title: 'Sotto', path, how: 'added', current: true })
    expect(addProject).toHaveBeenCalledWith('Sotto', path)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(newest)
  }, 60_000)

  it('leaves a copy with uncommitted changes or on another branch as it was, and says why', async () => {
    const path = await userClone('Sotto')
    const before = await git(path, 'rev-parse', 'HEAD')
    const newest = await moveGitHubOn()
    await writeFile(join(path, 'README.md'), '# Mine\n')
    // Fetched all the same, so a new worktree can start from origin/main without the checkout moving.
    expect(await copies().setup.setUp({ repository, title: 'Sotto' })).toMatchObject({ ok: true, how: 'added', current: false, reason: 'it has uncommitted changes', fetched: 'main' })
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(before)
    expect(await git(path, 'rev-parse', 'refs/remotes/origin/main')).toBe(newest)
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('# Mine\n')
    await git(path, 'switch', '-q', '-c', 'feat/mine')
    expect(await copies().setup.setUp({ repository, title: 'Sotto' })).toMatchObject({ ok: true, current: false, reason: 'it is on another branch', fetched: 'main' })
    expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/mine')
  }, 60_000)

  it('clones the repository into the folder Settings name when there is no copy', async () => {
    const configured = join(root, 'configured')
    const { setup, addProject } = copies({ projectsDirectory: () => configured })
    const result = await setup.setUp({ repository, title: 'Sotto' })
    const path = join(configured, 'Sotto')
    expect(result).toEqual({ ok: true, projectId: `project:${path}`, title: 'Sotto', path, how: 'cloned', current: true })
    expect(addProject).toHaveBeenCalledWith('Sotto', path)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(await git(seed, 'rev-parse', 'HEAD'))
  }, 60_000)

  it('clones into the folder most projects sit in, or Projects at home, never one of Sotto’s own', async () => {
    const own = join(root, 'sotto-data')
    const { setup } = copies({ projects: () => [{ path: join(own, 'watcher', 'workspace') }, { path: join(own, 'watcher', 'other') }] })
    expect(await setup.setUp({ repository, title: 'Sotto' })).toMatchObject({ ok: true, how: 'cloned', path: join(home, 'Projects', 'Sotto') })
  }, 60_000)

  it('refuses a folder of the same name that is something else, and keeps it', async () => {
    await mkdir(join(projects, 'Sotto'))
    await writeFile(join(projects, 'Sotto', 'mine.txt'), 'mine\n')
    const { setup, addProject } = copies()
    expect(await setup.setUp({ repository, title: 'Sotto' })).toEqual({ ok: false,
      message: `There is already a folder named Sotto in ${projects} that is not a copy of o/Sotto. Clone o/Sotto there under another name yourself, or name another machine.` })
    expect(await readFile(join(projects, 'Sotto', 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(addProject).not.toHaveBeenCalled()
  }, 60_000)

  it('removes only the folder it made when the clone fails, and says what to do', async () => {
    const { setup, addProject } = copies({ cloneUrl: () => join(root, 'missing.git') })
    const result = await setup.setUp({ repository, title: 'Sotto' })
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.message).toMatch(/^Git could not clone o\/Sotto into .*Sotto removed the unfinished copy\. Clone it there yourself, or name another machine\.$/u)
    expect(await exists(join(projects, 'Sotto'))).toBe(false)
    expect(await exists(projects)).toBe(true)
    expect(addProject).not.toHaveBeenCalled()
  }, 60_000)

  it('says the copy is cloned but not a project when adding it is refused', async () => {
    const { setup } = copies({ addProject: async () => { throw new Error('Connect Claude Code before creating a project.') } })
    expect(await setup.setUp({ repository, title: 'Sotto' })).toEqual({ ok: false,
      message: `Sotto cloned o/Sotto into ${join(projects, 'Sotto')} but could not add it as a project. Connect Claude Code before creating a project.` })
  }, 60_000)

  it('clones once for two setups of one repository asked together', async () => {
    const run = vi.fn(runGitStatusCommand)
    const { setup, addProject } = copies({ run })
    const [first, second] = await Promise.all([setup.setUp({ repository, title: 'Sotto' }), setup.setUp({ repository: { ...repository, owner: 'O' }, title: 'Sotto' })])
    expect(second).toEqual(first)
    expect(first).toMatchObject({ ok: true, how: 'cloned' })
    expect(addProject).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.filter(([, , args]) => args[0] === 'clone')).toHaveLength(1)
  }, 60_000)

  it('refuses a repository that would leave the projects folder or name a host other than GitHub, and touches nothing', async () => {
    const run = vi.fn(runGitStatusCommand)
    const { setup, addProject } = copies({ run })
    for (const named of [{ ...repository, name: '..' }, { ...repository, name: '../outside' }, { ...repository, owner: 'a/b' }, { ...repository, host: 'unlisted.example' }, { ...repository, host: 'github.com:22' }]) {
      expect(projectSetupRequestSchema.safeParse({ repository: named, title: 'Sotto' }).success).toBe(false)
      expect(await setup.setUp({ repository: named, title: 'Sotto' })).toMatchObject({ ok: false, message: expect.stringMatching(/is not a GitHub repository Sotto can clone\. Nothing was set up\.$/u) })
    }
    expect(projectSetupRequestSchema.safeParse({ repository, title: 'Sotto' }).success).toBe(true)
    expect(run.mock.calls.filter(([, , args]) => args[0] === 'clone')).toHaveLength(0)
    expect(addProject).not.toHaveBeenCalled()
  })

  it('stops a clone under way when Sotto closes, removes what it made, and sets nothing up after', async () => {
    let started!: () => void
    const cloning = new Promise<void>(resolve => { started = resolve })
    const { setup, addProject } = copies({ run: (cwd, command, args, options) => {
      if (args[0] !== 'clone') return runGitStatusCommand(cwd, command, args, options)
      started()
      return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('git was stopped.')), { once: true }))
    } })
    const result = setup.setUp({ repository, title: 'Sotto' })
    await cloning
    setup.close()
    expect(await result).toEqual({ ok: false, message: 'Sotto closed there while cloning o/Sotto. Sotto removed the unfinished copy. Try again once it is open.' })
    expect(await exists(join(projects, 'Sotto'))).toBe(false)
    expect(await setup.setUp({ repository, title: 'Sotto' })).toEqual({ ok: false, message: 'Sotto is closing there, so it set nothing up. Try again once it is open.' })
    expect(addProject).not.toHaveBeenCalled()
  }, 60_000)
})
