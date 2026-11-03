// Installed-app diagnostic with microphone permission already granted. Prepare a blank TextEdit document,
// enable Ctrl+Alt+Space, turn AI cleanup off,
// and leave Sotto's Dictate page selected. For --one/--warm, launch with --dictation-timing and focus TextEdit.
// --cold quits/relaunches Sotto, requires its enabled Start dictation control, then activates TextEdit.
//
//   node scripts/measure-dictation-gaps.mjs --one --out release/dictation-cold.jsonl
//   node scripts/measure-dictation-gaps.mjs --cold 10 --out release/dictation-cold.jsonl
//   node scripts/measure-dictation-gaps.mjs --warm 20 --out release/dictation-warm.jsonl
//   node scripts/measure-dictation-gaps.mjs --summarize release/dictation-warm.jsonl
//
// The utterance goes directly from `say` to the speakers: no audio file. The operator must verify the pilot
// appears in TextEdit; paste-keystroke-sent alone cannot prove that. Five seconds starts at first-audio-chunk.
// This baseline deliberately speaks after capture begins; it does not verify speech beginning at 150 ms.
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const { values } = parseArgs({ options: {
  one: { type: 'boolean' }, warm: { type: 'string' }, cold: { type: 'string' }, summarize: { type: 'string' },
  log: { type: 'string' }, out: { type: 'string' },
} })
if ([values.one, values.warm, values.cold, values.summarize].filter(Boolean).length !== 1) {
  throw new Error('Choose --one, --warm N, --cold N, or --summarize FILE')
}
const eventSource = readFileSync(new URL('../src/shared/dictationTiming.ts', import.meta.url), 'utf8')
const vocabulary = /DICTATION_TIMING_EVENTS = \[([\s\S]*?)\] as const/.exec(eventSource)?.[1]
if (!vocabulary) throw new Error('Cannot read the fixed dictation timing vocabulary')
const eventNames = new Set([...vocabulary.matchAll(/'([^']+)'/g)].map(match => match[1]))
const logPath = resolve(values.log ?? join(homedir(), 'Library/Application Support/sotto/dictation-timings.jsonl'))
const outputPath = resolve(values.out ?? 'release/dictation-gaps.jsonl')
const execute = promisify(execFile)

// Outside data is checked here once. Saved runs hold fixed event keys and numeric arrays only.
function parseLine(line) {
  const value = JSON.parse(line)
  if (value && Object.keys(value).length === 2 && eventNames.has(value.event)
    && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) return value
  if (value && Object.keys(value).every(key => ['events', 'speechDurationMs', 'captureDurationMs'].includes(key))
    && value.events && typeof value.events === 'object' && !Array.isArray(value.events)
    && Object.entries(value.events).every(([event, times]) => eventNames.has(event) && Array.isArray(times)
      && times.length > 0 && times.every(time => Number.isFinite(time) && time >= 0))
    && ['speechDurationMs', 'captureDurationMs'].every(key => value[key] === undefined
      || (Number.isFinite(value[key]) && value[key] >= 0))) return value
  throw new Error('Invalid numeric dictation timing record')
}

function readRuns(path) {
  const runs = []
  let current
  for (const line of readFileSync(path, 'utf8').split('\n').filter(line => line.trim())) {
    const entry = parseLine(line)
    if (entry.events) { runs.push(entry); continue }
    if (entry.event === 'hotkey-received') { current = { events: {} }; runs.push(current) }
    if (current) (current.events[entry.event] ??= []).push(entry.elapsedMs)
  }
  return runs
}

const metricPairs = {
  hotkeyToListeningCommittedMs: ['hotkey-received', 'widget-listening-committed'],
  hotkeyToListeningShownMs: ['hotkey-received', 'widget-listening-shown'],
  hotkeyToFirstAudioChunkMs: ['hotkey-received', 'first-audio-chunk'],
  microphoneRequestMs: ['microphone-request-started', 'microphone-resolved'],
  stopToRecorderStoppedMs: ['stop-pressed', 'recorder-stop-resolved'],
  stopToLastSegmentMs: ['stop-pressed', 'last-segment-transcribed'],
  stopToPasteKeystrokeMs: ['stop-pressed', 'paste-keystroke-sent'],
  stopToDeliveryReturnedMs: ['stop-pressed', 'delivery-returned'],
  deliveryMs: ['delivery-started', 'delivery-returned'],
  historyMs: ['history-started', 'history-returned'],
}
const stagePairs = {
  commandDeliveryMs: ['dictation-command-sent', 'dictation-command-received'],
  widgetShowMs: ['widget-show-started', 'widget-shown'],
  audioContextMs: ['audio-context-started', 'audio-context-ready'],
  workletLoadMs: ['worklet-load-started', 'worklet-loaded'],
  microphoneRequestMs: ['microphone-request-started', 'microphone-resolved'],
  sourceConnectMs: ['source-connect-started', 'source-connected'],
  startCueMs: ['start-cue-started', 'start-cue-returned'],
  recorderStopMs: ['recorder-stop-started', 'recorder-stop-resolved'],
  transcriptionRequestMs: ['transcription-request-started', 'transcription-request-returned'],
  cleanupMs: ['cleanup-started', 'cleanup-returned'],
  cleanupRequestMs: ['cleanup-request-started', 'cleanup-request-returned'],
  deliveryMs: ['delivery-started', 'delivery-returned'],
  focusedAppMs: ['focused-app-started', 'focused-app-returned'],
  clipboardWriteMs: ['clipboard-write-started', 'clipboard-written'],
  widgetHideMs: ['widget-hide-started', 'widget-hidden'],
  pasteDelayMs: ['paste-delay-started', 'paste-delay-ended'],
  pasteKeystrokeMs: ['paste-keystroke-started', 'paste-keystroke-sent'],
  pasteSettleMs: ['paste-settle-started', 'paste-settle-ended'],
  historyMs: ['history-started', 'history-returned'],
}
const handoffPairs = {
  hotkeyToCommandMs: ['hotkey-received', 'dictation-command-sent', 0],
  commandToRecorderMs: ['dictation-command-received', 'recorder-started', 0],
  recorderToAudioContextMs: ['recorder-started', 'audio-context-started'],
  audioContextToWorkletMs: ['audio-context-ready', 'worklet-load-started'],
  workletToMicrophoneMs: ['worklet-loaded', 'microphone-request-started'],
  microphoneToSourceMs: ['microphone-resolved', 'source-connect-started'],
  microphoneToListeningDispatchMs: ['microphone-resolved', 'started-dispatched'],
  listeningDispatchToSourceMs: ['started-dispatched', 'source-connect-started'],
  sourceToListeningDispatchMs: ['source-connected', 'started-dispatched'],
  listeningDispatchToCommitMs: ['started-dispatched', 'widget-listening-committed'],
  listeningCommitToShownMs: ['widget-listening-committed', 'widget-listening-shown'],
  sourceToFirstChunkMs: ['source-connected', 'first-audio-chunk'],
  stopToCommandMs: ['stop-pressed', 'dictation-command-sent'],
  stopCommandToControllerMs: ['dictation-command-received', 'controller-stop-received'],
  controllerToRecorderStopMs: ['controller-stop-received', 'recorder-stop-started'],
  recorderStopToTranscriptionMs: ['recorder-stop-resolved', 'transcription-request-started'],
  transcriptionToLastSegmentMs: ['transcription-request-returned', 'last-segment-transcribed'],
  lastSegmentToCleanupMs: ['last-segment-transcribed', 'cleanup-started'],
  cleanupToRequestMs: ['cleanup-started', 'cleanup-request-started', 0],
  cleanupRequestToReturnMs: ['cleanup-request-returned', 'cleanup-returned'],
  cleanupToDeliveryMs: ['cleanup-returned', 'delivery-started'],
  lastSegmentToDeliveryMs: ['last-segment-transcribed', 'delivery-started'],
  deliveryToFocusedAppMs: ['delivery-started', 'focused-app-started'],
  deliveryToClipboardMs: ['delivery-started', 'clipboard-write-started'],
  clipboardToWidgetHideMs: ['clipboard-written', 'widget-hide-started'],
  focusedAppToWidgetHideMs: ['focused-app-returned', 'widget-hide-started'],
  widgetHideToPasteDelayMs: ['widget-hidden', 'paste-delay-started'],
  pasteDelayToKeystrokeMs: ['paste-delay-ended', 'paste-keystroke-started'],
  pasteKeystrokeToSettleMs: ['paste-keystroke-sent', 'paste-settle-started'],
  pasteSettleToDeliveryReturnMs: ['paste-settle-ended', 'delivery-returned'],
  deliveryToHistoryMs: ['delivery-returned', 'history-started'],
  historyToReadyDispatchMs: ['history-returned', 'ready-dispatched'],
  readyDispatchToWidgetMs: ['ready-dispatched', 'widget-ready'],
}
function sampleSummary(samples) {
  return Object.fromEntries(Object.entries(samples).map(([key, numbers]) => {
    const sorted = numbers.toSorted((a, b) => a - b)
    return [key, { count: numbers.length, samples: numbers, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }]
  }))
}
function summarize(runs) {
  const metrics = {}, stages = {}, handoffs = {}, events = {}
  const add = (samples, name, value) => { (samples[name] ??= []).push(Math.round(value * 1000) / 1000) }
  for (const run of runs) {
    for (const [name, [from, to]] of Object.entries(metricPairs)) {
      const start = run.events[from]?.at(-1)
      const end = run.events[to]?.at(-1)
      if (start === undefined || end === undefined || end < start) {
        throw new Error(`Incomplete recording: ${name}`)
      }
    }
    if (!run.events['widget-ready']) throw new Error('Incomplete recording: widget-ready')
    const requests = run.events['cleanup-request-started'] ?? []
    const returns = run.events['cleanup-request-returned'] ?? []
    if (requests.length !== returns.length || requests.some((start, index) => returns[index] < start)) {
      throw new Error('Incomplete cleanup request timing')
    }
    if (requests.length > 0) {
      const requestMs = requests.reduce((sum, start, index) => sum + returns[index] - start, 0)
      add(metrics, 'cleanupRequestMs', requestMs)
      add(metrics, 'stopToPasteBeyondCleanupRequestsMs', run.events['paste-keystroke-sent'].at(-1)
        - run.events['stop-pressed'].at(-1) - requestMs)
      if (run.events['cleanup-started'] && run.events['cleanup-returned']) {
        add(metrics, 'cleanupBeyondRequestsMs', run.events['cleanup-returned'].at(-1)
          - run.events['cleanup-started'].at(-1) - requestMs)
      }
    }
    for (const [event, times] of Object.entries(run.events)) for (const time of times) add(events, event, time)
    for (const [samples, pairs] of [[metrics, metricPairs], [handoffs, handoffPairs]]) {
      for (const [name, [from, to, index = -1]] of Object.entries(pairs)) {
        const start = run.events[from]?.at(index)
        const end = run.events[to]?.at(index)
        if (start !== undefined && end !== undefined && end >= start) add(samples, name, end - start)
      }
    }
    for (const [name, [from, to]] of Object.entries(stagePairs)) {
      for (const [index, start] of (run.events[from] ?? []).entries()) {
        const end = run.events[to]?.[index]
        if (end !== undefined && end >= start) add(stages, name, end - start)
      }
    }
    for (const key of ['speechDurationMs', 'captureDurationMs']) if (run[key] !== undefined) add(metrics, key, run[key])
  }
  return { runs: runs.length, completeRuns: runs.filter(run => run.events['widget-ready'] && run.events['paste-keystroke-sent']).length,
    metrics: sampleSummary(metrics), stages: sampleSummary(stages), handoffs: sampleSummary(handoffs), events: sampleSummary(events) }
}

if (values.summarize) {
  process.stdout.write(`${JSON.stringify(summarize(readRuns(resolve(values.summarize))), null, 2)}\n`)
} else {
  if (process.platform !== 'darwin') throw new Error('Live measurements require macOS and agent-desktop')
  const count = values.one ? 1 : Number(values.cold ?? values.warm)
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('--warm/--cold must be a positive integer')
  const runs = existsSync(outputPath) ? readRuns(outputPath) : []
  mkdirSync(dirname(outputPath), { recursive: true })

  async function desktopCommand(args, timeout = 15_000) {
    // Keep command output (AX values included) out of saved artifacts and console logs.
    const { stdout } = await execute('agent-desktop', args, { timeout }).catch(error => {
      throw new Error(`agent-desktop ${args[0]} failed (${error.code ?? 'unknown'}); observe app state before retrying`)
    })
    const result = JSON.parse(stdout)
    if (!result.ok) throw new Error(`agent-desktop ${args[0]} failed: ${result.error?.code ?? 'unknown'}`)
    return result.data
  }
  const desktopPress = () => desktopCommand(['press', 'ctrl+alt+space'])

  async function coldLaunch() {
    await desktopCommand(['close-app', 'Sotto'])
    await desktopCommand(['launch', 'com.sotto.desktop', '--arg=--dictation-timing', '--activate'], 45_000)
    const room = await desktopCommand(['snapshot', '--app', 'Sotto', '--wait-for', 'radiobutton:Dictate', '--wait-timeout', '60000'], 75_000)
    const roomNodes = [room.tree]
    let dictate
    for (const node of roomNodes) {
      if (node?.role === 'radiobutton' && node.name === 'Dictate') dictate = node.ref_id
      if (Array.isArray(node?.children)) roomNodes.push(...node.children)
    }
    if (!dictate) throw new Error('Dictate control was not observed; no hotkey was sent')
    await desktopCommand(['click', dictate, '--headed'])
    const snapshot = await desktopCommand(['snapshot', '--app', 'Sotto', '--wait-for', 'button:Start dictation', '--wait-timeout', '60000'], 75_000)
    if (snapshot.complete !== true || !snapshot.tree) throw new Error('Speech-model readiness observation was incomplete')
    const nodes = [snapshot.tree]
    let ready
    for (const node of nodes) {
      if (node.role === 'button' && node.name === 'Start dictation') ready = node.ref_id
      if (Array.isArray(node.children)) nodes.push(...node.children)
    }
    if (!ready) throw new Error('Enabled Start dictation control was not observed; no hotkey was sent')
    const enabled = await desktopCommand(['is', ready, '--property', 'enabled'])
    if (enabled.result !== true) throw new Error('Start dictation is not enabled; no hotkey was sent')
    await desktopCommand(['launch', 'TextEdit', '--activate'], 45_000)
  }

  async function measure() {
    let position = existsSync(logPath) ? statSync(logPath).size : 0
    let partial = ''
    let active = false
    let failure
    const run = { events: {} }
    const waiters = new Set()
    const fail = error => {
      failure = error
      for (const waiter of waiters) waiter.reject(error)
      waiters.clear()
    }
    const readNew = () => {
      // A logger writes asynchronously; retain an incomplete final line until the next file event.
      try {
        const descriptor = openSync(logPath, 'r')
        try {
          const size = statSync(logPath).size
          if (size < position) throw new Error('Timing log was truncated during a measurement')
          const buffer = Buffer.alloc(size - position)
          const length = readSync(descriptor, buffer, 0, buffer.length, position)
          position += length
          const lines = (partial + buffer.toString('utf8', 0, length)).split('\n')
          partial = lines.pop()
          for (const line of lines.filter(Boolean)) {
            const entry = parseLine(line)
            if (entry.events) throw new Error('Expected the app timing log, not saved measurements')
            if (entry.event === 'hotkey-received') {
              if (active) throw new Error('Another recording started before this measurement finished')
              active = true
            }
            if (!active) continue // Startup events and the previous recording cannot satisfy a wait.
            ;(run.events[entry.event] ??= []).push(entry.elapsedMs)
            for (const waiter of waiters) if (waiter.event === entry.event) {
              waiter.resolve(); waiters.delete(waiter)
            }
          }
        } finally { closeSync(descriptor) }
      } catch (error) { fail(error) }
    }
    const watcher = watch(dirname(logPath), (_type, filename) => {
      if (filename === null || filename.toString() === basename(logPath)) readNew()
    })
    watcher.on('error', fail)
    const waitFor = event => {
      if (failure) return Promise.reject(failure)
      if (run.events[event]) return Promise.resolve()
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          rejectWait(new Error(`Timed out waiting for ${event}; recording state must be observed before any retry`))
        }, 30_000)
        const waiter = { event, resolve: () => { clearTimeout(timer); resolveWait() }, reject: error => { clearTimeout(timer); rejectWait(error) } }
        waiters.add(waiter)
      })
    }
    try {
      await desktopPress()
      await waitFor('hotkey-received')
      await waitFor('first-audio-chunk')
      const captureStart = performance.now()
      const speechStart = performance.now()
      await execute('/usr/bin/say', ['-r', '220', 'Sotto starts listening quickly and pastes these words.'], { timeout: 15_000 })
      run.speechDurationMs = Math.round(performance.now() - speechStart)
      if (run.speechDurationMs > 5_000) throw new Error('Spoken phrase exceeded the five-second capture; observe recording state before stopping')
      await sleep(Math.max(0, 5_000 - (performance.now() - captureStart)))
      if (failure) throw failure
      await desktopPress()
      await waitFor('stop-pressed')
      run.captureDurationMs = Math.round(run.events['stop-pressed'][0] - run.events['first-audio-chunk'][0])
      await waitFor('paste-keystroke-sent')
      await waitFor('widget-ready')
      if (run.events['widget-permission-waiting-committed']) {
        throw new Error('Waiting for microphone appeared during a granted-permission measurement')
      }
      return run
    } finally {
      watcher.close()
      for (const waiter of waiters) waiter.reject(new Error('Measurement ended'))
    }
  }

  for (let index = 0; index < count; index++) {
    if (values.cold) await coldLaunch()
    else if (index > 0) await sleep(5_000)
    const run = await measure()
    const summary = summarize([...runs, run])
    appendFileSync(outputPath, `${JSON.stringify(run)}\n`, { mode: 0o600 })
    runs.push(run)
    writeFileSync(`${outputPath}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    const metrics = Object.fromEntries(['hotkeyToListeningShownMs', 'hotkeyToFirstAudioChunkMs', 'stopToPasteKeystrokeMs'].map(key => {
      const reading = summary.metrics[key]
      return [key, reading ? { p50: reading.p50, p95: reading.p95 } : null]
    }))
    process.stdout.write(`${JSON.stringify({ completed: index + 1, requested: count, runs: summary.runs, completeRuns: summary.completeRuns, metrics })}\n`)
  }
}
