// Every take starts from the same moment: the state prepare.mjs leaves behind, saved once and put back before each take.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fake, paths } from './stage.mjs'

const SEED = join(paths.root, 'seed')
// The home folder's own root holds the junction to Claude's history, so only its AppData is saved.
const FOLDERS = [['profile', paths.profile], ['fakes', paths.fakes], ['pantry', paths.project], ['remotes', join(paths.root, 'remotes')], ['appdata', join(paths.home, 'AppData')]]

function mirror(from, to) {
  mkdirSync(to, { recursive: true })
  try { execFileSync('robocopy', [from, to, '/MIR', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1'], { stdio: 'ignore' }) }
  catch (error) { if (error.status >= 8) throw new Error(`robocopy failed (${error.status}) copying ${from} to ${to}`, { cause: error }) }
}

export function saveSeed() { for (const [name, path] of FOLDERS) mirror(path, join(SEED, name)) }
export function restoreSeed() {
  if (!existsSync(SEED)) throw new Error('No seed yet: run `npm run capture -- prepare` first.')
  for (const [name, path] of FOLDERS) mirror(join(SEED, name), path)
  if (!existsSync(join(paths.home, '.claude'))) execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', join(paths.home, '.claude'), join(fake.claude, 'home')], { stdio: 'ignore' })
}
