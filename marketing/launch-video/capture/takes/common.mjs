// What every take shares: the seed put back, the profile's settings for the take, and Sotto launched on it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../lib/stage.mjs'
import { launch, sleep } from '../lib/rig.mjs'
import { restoreSeed } from '../lib/snapshot.mjs'

export function threadIds() { return JSON.parse(readFileSync(join(paths.root, 'threads.json'), 'utf8')) }

function patchSettings(patch) {
  const file = join(paths.profile, 'settings.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }))
}

/**
 * Starts a take from the seed. With `dictation`, Chromium's fake microphone plays the WAV once when
 * Sotto opens it, and the video's launcher answers the transcription request with `transcript`
 * (the user asked for transcription to be simulated rather than sent to OpenRouter).
 */
export async function deskTake({ dictation, widgetEdge = 'right', settings = {}, topmost = true } = {}) {
  restoreSeed()
  // A stand-in key, so Sotto goes on to transcribe; no request reaches OpenRouter (deskMain.cjs), and Settings is never shown.
  patchSettings({ streamingAsr: false, autoPaste: true, ...(dictation ? { llmApiKey: 'sk-or-v1-launch-video-stand-in' } : {}), ...settings })
  writeFileSync(join(paths.profile, 'widget-placement.json'), JSON.stringify({ version: 3, placement: { edge: widgetEdge } }))
  const rig = await launch({
    extraArgs: dictation ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${dictation.wav}%noloop`] : [],
    env: dictation ? { SOTTO_VIDEO_TRANSCRIPT: dictation.transcript, SOTTO_VIDEO_TRANSCRIBE_MS: '650' } : {},
    topmost,
  })
  await sleep(2500)
  if (dictation) await holdsShortcut(rig)
  return rig
}

/**
 * The dictation takes press the real Ctrl+Shift+Space. If another Sotto holds it, that press would start
 * dictation there instead, so the take stops before pressing anything.
 */
async function holdsShortcut(rig) {
  const held = await rig.app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+Space'))
  if (!held) {
    await rig.close()
    throw new Error('Another app holds Ctrl+Shift+Space. Change your own Sotto’s dictation shortcut for the take, then run it again.')
  }
}
