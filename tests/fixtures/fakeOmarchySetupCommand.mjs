// Child-process stand-ins for desktop commands. Every file is in the test's private HOME.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
const [command, ...args] = process.argv.slice(2)
const path = process.env.SOTTO_SETUP_FIXTURE_STATE
const state = JSON.parse(readFileSync(path, 'utf8'))
const key = [command, ...args].join(' ')
state.calls.push(`${command}.${args[0] ?? ''}`)
writeFileSync(path, JSON.stringify(state))
async function pause() {
  const latest = JSON.parse(readFileSync(path, 'utf8'))
  latest.reached = true
  writeFileSync(path, JSON.stringify(latest))
  await new Promise(() => { setInterval(() => {}, 1000) })
}
if (state.blockAt === key) await pause()
if (command === 'bash') {
  const result = spawnSync('/usr/bin/bash', args, { env: process.env, stdio: 'inherit' })
  if (result.status === 0 && state.blockAt === 'bash after') await pause()
  process.exit(result.status ?? 1)
}
if (state.fail && key.startsWith(state.fail)) process.exit(1)
const home = process.env.HOME
const bindings = readFileSync(join(home, '.config/hypr/bindings.lua'), 'utf8')
const ours = bindings.includes('-- Sotto Omarchy setup')
if (key === 'hyprctl binds -j') {
  process.stdout.write(JSON.stringify([
    { key: 'F9', modmask: 0, dispatcher: 'exec', arg: ours ? 'sotto dictation start' : 'voxtype record start' },
    { key: 'F9', modmask: 0, dispatcher: 'exec', arg: ours ? 'sotto dictation stop' : 'voxtype record stop', release: true },
    { key: 'X', modmask: 68, dispatcher: 'exec', arg: ours ? 'sotto dictation toggle' : 'voxtype record toggle' },
  ]))
} else if (key === 'hyprctl configerrors') {
  process.stdout.write(state.oldError + (ours ? state.newError : ''))
} else if (command === 'luac') process.exit(state.lua ? 0 : 1)
else if (key === 'omarchy-shell shell ping') process.exit(state.shell ? 0 : 1)
else if (key === 'omarchy-shell shell listPlugins') process.stdout.write('[{"id":"sotto.dictation"}]')
else if (key.startsWith('omarchy bar put') || key.startsWith('omarchy bar move') || key.startsWith('omarchy plugin disable')) {
  const configPath = join(home, '.config/omarchy/shell.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (key.startsWith('omarchy bar put') && config.plugins?.some(entry => entry === 'sotto.dictation' || typeof entry === 'object' && entry.id === 'sotto.dictation')) process.exit(0)
  if (key.startsWith('omarchy plugin disable')) config.plugins = config.plugins?.filter(entry => entry !== 'sotto.dictation' && (typeof entry !== 'object' || entry.id !== 'sotto.dictation'))
  config.bar.layout.center = key.startsWith('omarchy bar') ? [{ id: 'sotto.dictation' }] : [{ id: 'omarchy.indicators' }]
  writeFileSync(configPath, JSON.stringify(config))
} else if (key.startsWith('omarchy bar set')) {
  const configPath = join(home, '.config/omarchy/shell.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.bar.layout.center.find(entry => entry.id === 'sotto.dictation')[args[3]] = JSON.parse(args[4])
  writeFileSync(configPath, JSON.stringify(config))
} else if (command === 'omarchy-theme-set-templates') {
  const next = join(home, '.local/state/omarchy/current/next-theme')
  if (!existsSync(join(home, '.config/omarchy/themed/sotto.json.tpl'))) process.exit(1)
  writeFileSync(join(next, 'sotto.json'), state.rendered)
}
if (state.blockAt === `after ${key}`) await pause()
