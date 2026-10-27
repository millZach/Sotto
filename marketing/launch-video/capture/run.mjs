// npm run capture [-- step ...]: prepare the seed, record the takes, and put their events on the footage's clock.
// With no steps it runs them all, in order. Build Sotto first (`npm run build` at the repository root).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/stage.mjs'

const steps = {
  prepare: async () => (await import('./prepare.mjs')).prepare(),
  hook: async () => (await import('./takes/hook.mjs')).hook(),
  split: async () => (await import('./takes/split.mjs')).split(),
  requests: async () => (await import('./takes/requests.mjs')).requests(),
  tools: async () => (await import('./takes/tools.mjs')).tools(),
  git: async () => (await import('./takes/git.mjs')).git(),
  worktrees: async () => (await import('./takes/worktrees.mjs')).worktrees(),
  anywhere: async () => (await import('./takes/anywhere.mjs')).anywhere(),
  themes: async () => (await import('./takes/themes.mjs')).themes(),
  sync: async () => (await import('./sync.mjs')).sync(),
}

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) throw new Error('Build Sotto first: npm run build at the repository root.')
const chosen = process.argv.slice(2)
for (const name of chosen.length ? chosen : Object.keys(steps)) {
  if (!steps[name]) throw new Error(`Unknown step ${name}. Steps: ${Object.keys(steps).join(', ')}`)
  console.log(`— ${name}`)
  await steps[name]()
}
