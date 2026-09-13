// @vitest-environment node
// Zero model turns. Isolated native config and Git working copies; no user settings are changed.
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { discoverClaudeSkills } from '../../src/main/agents/claudeSkills'
import { ClaudeSubscriptionClient } from '../../src/main/agents/subscriptionClaude'

it.skipIf(process.env.SOTTO_PHASE3_CATALOG_LIVE !== '1')('Claude native catalog honors configured home, flags, precedence and a real Git worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase3-catalog-')); const home = join(root, 'config'); const project = join(root, 'project'); const worktree = join(root, 'worktree')
  const skill = async (directory: string, name: string, metadata: string) => { const path = join(directory, 'skills', name); await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), `---\n${metadata}\n---\nSynthetic test only.\n`) }
  await mkdir(project)
  await skill(home, 'sotto-collision', 'description: User winner')
  await skill(join(project, '.claude'), 'sotto-collision', 'description: Project loser')
  await skill(join(project, '.claude'), 'sotto-hidden', 'description: Hidden\nuser-invocable: no')
  await skill(join(project, '.claude'), 'sotto-off', 'description: Disabled')
  await skill(join(project, '.claude'), 'sotto-manual', 'description: Manual\ndisable-model-invocation: true')
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { 'sotto-off': 'off' } }))
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: project, windowsHide: true })
  await git(['init', '-b', 'main']); await git(['add', '.']); await git(['-c', 'user.name=Sotto synthetic', '-c', 'user.email=sotto@example.invalid', 'commit', '-m', 'Synthetic native catalog'])
  await git(['worktree', 'add', '-b', 'catalog', worktree])
  await skill(join(worktree, '.claude'), 'sotto-worktree-only', 'description: Worktree only')
  const client = new ClaudeSubscriptionClient(root); const executable = await client.findExecutable(); expect(executable).toBeTruthy()
  const environment = { ...client.environment(), CLAUDE_CONFIG_DIR: home }
  const catalog = await discoverClaudeSkills('synthetic', worktree, executable!, [], environment, 15000)
  expect(catalog.skills.find(skill => skill.name === 'sotto-collision')).toMatchObject({ scope: 'user', description: expect.stringContaining('User winner') })
  expect(catalog.skills.some(skill => skill.name === 'sotto-hidden')).toBe(false)
  expect(catalog.skills.some(skill => skill.name === 'sotto-off')).toBe(false)
  expect(catalog.skills.some(skill => skill.name === 'sotto-manual')).toBe(true)
  expect(catalog.skills.some(skill => skill.name === 'sotto-worktree-only')).toBe(true)
  const mainCatalog = await discoverClaudeSkills('main', project, executable!, [], environment, 15000)
  expect(mainCatalog.skills.some(skill => skill.name === 'sotto-worktree-only')).toBe(false)
  await writeFile(join(worktree, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { 'sotto-manual': 'off' } }))
  expect((await discoverClaudeSkills('synthetic', worktree, executable!, [], environment, 15000)).skills.some(skill => skill.name === 'sotto-manual')).toBe(false)
  console.log(JSON.stringify({ nativeCatalogEvidence: root, modelCalls: 0, initializationProbes: 3, verified: ['configured home', 'user precedence', 'YAML invocability', 'disabled override', 'manual-only invocation', 'worktree scope', 'refresh'] }))
}, 60000)
