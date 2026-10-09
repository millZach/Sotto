// Built-app proof, with microphone and provider effects scripted; commands use the real sotto client and socket.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { E2E_TRANSCRIPT, type E2EScenario } from '../../src/shared/e2e'
import { closeSotto, e2eEnvironment, firstSottoWindow, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'

const run = promisify(execFile)

test('publishes private shell state, retries and discards, remembers placement and steps aside for the plugin', async () => {
  test.skip(process.platform !== 'linux', 'Omarchy shell plumbing')
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  const home = join(profile, 'home')
  const config = join(profile, 'config')
  const plugin = join(home, '.config/omarchy/plugins/sotto.dictation')
  const statePath = join(profile, 'sotto/dictation-state.json')
  await mkdir(home)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, autoPaste: false, successDisplayMs: 5_000 }))
  let launched: LaunchedSotto | undefined
  let rawApp: ChildProcess | undefined
  let rawAppClosed: Promise<number | null> | undefined
  let mainPid: number | undefined
  let mainStart: number | undefined
  const readMainStart = async (): Promise<void> => {
    const stat = await readFile(`/proc/${mainPid}/stat`, 'utf8')
    mainStart = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19])
    expect(Number.isSafeInteger(mainStart)).toBe(true)
  }
  const launch = async (scenario: E2EScenario): Promise<LaunchedSotto> => {
    const app = await launchSotto(scenario, profile, {
      createProfile: async () => { throw new Error('Use the owned profile') },
      launch: options => electron.launch({ ...options, env: { ...options?.env, HOME: home, XDG_CONFIG_HOME: config } }),
      firstWindow: firstSottoWindow,
      removeProfile: path => rm(requireOwnedE2EProfile(path), { recursive: true, force: true }),
    })
    console.log(`Built app PID ${app.app.process().pid}; isolated profile; scripted microphone and transcription`)
    mainPid = app.app.process().pid
    await readMainStart()
    await openPage(app.page, 'Dictate')
    await expect.poll(read).toMatchObject({ version: 1, pid: mainPid, pidStart: mainStart, state: 'idle' })
    return app
  }
  const command = (...args: string[]) => run(join(process.cwd(), 'apps/omarchy/sotto'), ['dictation', ...args], { env: { ...process.env, XDG_RUNTIME_DIR: profile } })
  const read = async (): Promise<Record<string, unknown>> => {
    try { return JSON.parse(await readFile(statePath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  const showState = async (label: string, state: string, extra: object = {}): Promise<void> => {
    expect(mainPid).toBeGreaterThan(0)
    await expect.poll(read).toMatchObject({ version: 1, pid: mainPid, pidStart: mainStart, state, ...extra })
    const raw = (await readFile(statePath, 'utf8')).trim()
    expect(raw).not.toContain(E2E_TRANSCRIPT)
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['version', 'pid', 'pidStart', 'state', 'since', 'updatedAt', 'detail', 'kept', 'edge'].sort())
    const published = JSON.parse(raw)
    if (published.detail !== null) expect(published.detail.length).toBeLessThan(60)
    if (published.kept) expect(published.detail).toContain('Recording kept.')
    console.log(`${label}: ${raw}`)
  }
  const widgetVisible = () => launched!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html'))?.isVisible() ?? false)
  const capture = async (name: string, visible: boolean): Promise<void> => {
    const output = process.env.SOTTO_PROOF_CAPTURE_DIR
    if (!output) return
    expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).toBeTruthy()
    expect(process.env.HYPRLAND_INSTANCE_SIGNATURE).not.toBe(process.env.SOTTO_PROOF_LIVE_SIGNATURE)
    // The nested compositor's locked parent can suspend frame callbacks. Ask
    // Electron to paint the full main frame before capturing the owned output.
    await launched!.app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!
      await main.webContents.capturePage(undefined, { stayAwake: true })
    })
    await expect.poll(async () => {
      const { stdout } = await run('hyprctl', ['clients', '-j'])
      const clients = JSON.parse(stdout) as Array<{ pid: number; title: string; mapped: boolean }>
      return clients.some(client => client.pid === launched!.app.process().pid && client.title === 'Sotto Widget' && client.mapped)
    }).toBe(visible)
    console.log(`compositor ${name}: Electron widget mapped=${visible}`)
    await run('grim', [join(output, name)])
  }
  const quit = async (): Promise<void> => {
    const pid = launched!.app.process().pid
    await launched!.app.evaluate(({ app }) => { app.quit() })
    await expect.poll(async () => stat(statePath).then(() => true, () => false)).toBe(false)
    await closeSotto(launched!)
    console.log(`quit PID ${pid}: dictation-state.json absent`)
    launched = undefined
  }
  try {
    launched = await launch('transcription-turned-away-twice')
    await showState('launch', 'idle', { edge: 'top' })
    console.log(`modes: sotto=${((await stat(join(profile, 'sotto'))).mode & 0o777).toString(8)} state=${((await stat(statePath)).mode & 0o777).toString(8)}`)
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    await command('start')
    await showState('start', 'listening')
    await command('stop')
    await showState('stop failed', 'failed', { kept: true })
    const firstFailure = (await read()).since as number
    await command('retry')
    await expect(launched.page.getByText('Try again did not get through.', { exact: false })).toBeVisible()
    await expect.poll(async () => (await read()).since as number).toBeGreaterThan(firstFailure)
    await showState('retry failed', 'failed', { kept: true })
    await command('retry')
    await showState('retry copied', 'copied', { kept: false })
    await command('start')
    await showState('start again', 'listening')
    await command('cancel')
    await showState('cancel', 'idle')
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ autoPaste: true }))
    await command('start')
    await showState('start for delivery', 'listening')
    await command('stop')
    await showState('stop delivered', 'delivered')
    for (const edge of ['left', 'right', 'bottom', 'top']) {
      await command('place', edge)
      await showState(`place ${edge}`, 'delivered', { edge })
      expect(JSON.parse(await readFile(join(profile, 'widget-placement.json'), 'utf8'))).toEqual({ version: 3, placement: { edge } })
    }
    await expect(command('place', '../left')).rejects.toThrow()
    await expect(command('unknown')).rejects.toThrow()
    console.log('unsafe edge and unknown verb: refused')
    await expect.poll(widgetVisible).toBe(true)
    await capture('widget-before-plugin.png', true)
    await mkdir(join(config, 'omarchy/plugins/sotto.dictation'), { recursive: true })
    // Leave the decoy installed throughout the HOME-folder transitions.
    await expect.poll(widgetVisible).toBe(true)
    console.log('plugin under alternate XDG_CONFIG_HOME: Electron widget visible=true')
    await mkdir(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(false)
    console.log(`plugin created under isolated HOME/.config (${plugin}): Electron widget visible=false`)
    await capture('plugin-present.png', false)
    await command('start')
    await showState('start with plugin', 'listening')
    expect(await widgetVisible()).toBe(false)
    await rm(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(true)
    console.log('plugin removed during dictation: Electron widget visible=true')
    await capture('widget-returned.png', true)
    await command('cancel')
    await showState('cancel after plugin removal', 'idle')
    await command('place', 'left')
    await showState('place before restart', 'idle', { edge: 'left' })
    await mkdir(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(false)
    await quit()
    launched = await launch('transcription-failure')
    await showState('restart saved edge', 'idle', { edge: 'left' })
    expect(await widgetVisible()).toBe(false)
    console.log('plugin present at startup: Electron widget visible=false')
    await command('start')
    await showState('start to discard', 'listening')
    await command('stop')
    await showState('stop to discard', 'failed', { kept: true })
    const beforeDiscardRetry = (await read()).since as number
    await command('retry')
    await expect(launched.page.getByText('Try again did not get through.', { exact: false })).toBeVisible()
    await expect.poll(async () => (await read()).since as number).toBeGreaterThan(beforeDiscardRetry)
    await showState('retry before discard', 'failed', { kept: true })
    await command('discard')
    await showState('discard', 'idle', { kept: false })
    await command('retry')
    await showState('retry without recording', 'idle', { kept: false })
    await rm(plugin, { recursive: true })
    await expect.poll(widgetVisible).toBe(true)
    console.log('plugin removed after discard: Electron widget visible=true')
    await quit()
    launched = await launch('design-processing')
    await command('start')
    await showState('start before processing cancel', 'listening')
    await command('stop')
    await showState('stop transcribing', 'transcribing', { kept: false })
    await command('cancel')
    await showState('cancel transcribing', 'idle')
    await quit()
    launched = await launch('design-permission')
    await command('start')
    await showState('start connecting', 'starting')
    await command('cancel')
    await showState('cancel connecting', 'idle')
    await quit()
    // Observe Electron's real exit event without a main-process debugger.
    // Check publication cleanup before the harness reaps any remaining handles.
    const exitSignal = join(profile, 'force-exit')
    const exitObserved = join(profile, 'exit-observed')
    const exitHook = join(profile, 'force-exit.cjs')
    await writeFile(exitHook, `const { app } = require('electron')
const { existsSync, writeFileSync } = require('node:fs')
process.once('exit', () => writeFileSync(${JSON.stringify(exitObserved)}, ''))
require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))})
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(exitSignal)})) { clearInterval(timer); app.exit() }
}, 25)
`)
    rawApp = spawn(join(process.cwd(), 'node_modules/electron/dist/electron'), [exitHook], {
      env: { ...e2eEnvironment('success', profile), HOME: home, XDG_CONFIG_HOME: config }, stdio: 'ignore',
    })
    const forcedPid = rawApp.pid
    mainPid = forcedPid
    await readMainStart()
    rawAppClosed = new Promise<number | null>((resolve, reject) => {
      rawApp!.once('error', reject)
      rawApp!.once('close', resolve)
    })
    console.log(`Built app PID ${forcedPid}; isolated profile; no main-process debugger`)
    await showState('launch before forced exit', 'idle')
    await command('start')
    await showState('start before forced exit', 'listening')
    await writeFile(exitSignal, '')
    await expect.poll(() => stat(exitObserved).then(() => true, () => false)).toBe(true)
    await expect.poll(read).toEqual({})
    console.log(`forced exit PID ${forcedPid}: Electron exit event observed; dictation-state.json absent`)
  } finally {
    if (rawApp?.exitCode === null) {
      rawApp.kill('SIGKILL')
      await rawAppClosed
      console.log(`Stopped forced-exit app PID ${rawApp.pid}`)
    }
    if (launched) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
