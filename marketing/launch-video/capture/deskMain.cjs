// The launch video's Desk rig entry: Sotto's production main, unpackaged, on the stage's throwaway profile.
// Unlike the e2e harness, the global shortcut, the widget, the recording and paste are the real ones.
/* eslint-disable @typescript-eslint/no-require-imports -- userData must be set before main loads. */
const { app, dialog } = require('electron')
const { resolve } = require('node:path')

if (app.isPackaged || process.env.SOTTO_VIDEO_DESK !== '1') throw new Error('The Desk rig needs an unpackaged opt-in launch.')
const profile = process.env.SOTTO_VIDEO_PROFILE
const project = process.env.SOTTO_VIDEO_PROJECT
if (!profile || !project) throw new Error('The Desk rig needs a profile and a project.')
for (const key of Object.keys(process.env)) if (key.startsWith('SOTTO_E2E') || key === 'SOTTO_MEMORY_PROBE') delete process.env[key]
app.setPath('userData', profile)
// Transcription is simulated for the video, at the user's request: the request Sotto makes to OpenRouter is
// answered here with the words the take's WAV speaks, after a pause like the service's. Every other request
// to OpenRouter is refused, so nothing leaves this computer. The recording, shortcut, widget and paste are real.
const transcript = process.env.SOTTO_VIDEO_TRANSCRIPT
if (transcript) {
  const realFetch = globalThis.fetch
  const pause = Number(process.env.SOTTO_VIDEO_TRANSCRIBE_MS || 650)
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://openrouter.ai/api/v1/audio/transcriptions') {
      await new Promise(resolve => setTimeout(resolve, pause))
      return new Response(JSON.stringify({ text: transcript }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('https://openrouter.ai/')) return new Response('{}', { status: 503 })
    return realFetch(input, init)
  }
}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
require(resolve(__dirname, '../../../out/main/index.js'))
