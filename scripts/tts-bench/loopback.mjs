/* global process, URL */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const qpcMs = () => Number(process.hrtime.bigint()) / 1e6

/** Captures only rendered output from targetPid and descendants. No PCM is retained. */
export async function startLoopback(targetPid) {
  if (!Number.isInteger(targetPid) || targetPid < 1) throw new Error('A positive target PID is required')
  const executable = fileURLToPath(new URL('../../artifacts/tts-bench/loopback-build/loopback.exe', import.meta.url))
  const child = spawn(executable, [String(targetPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const packets = []
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data.toString() })
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const completed = new Promise((resolve, reject) => {
    child.once('error', (error) => { rejectReady(error); reject(error) })
    child.once('exit', (code) => {
      if (code !== 0) { const error = new Error(`Loopback exited ${code}: ${stderr}`); rejectReady(error); reject(error) }
      else resolve()
    })
  })
  // The caller awaits this at stop; avoid unhandled rejection if startup fails first.
  completed.catch(() => {})
  createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line)
    if (event.type === 'ready') resolveReady({ ...event, receivedQpcMs: qpcMs() })
    if (event.type === 'packet') packets.push(event)
  })
  const metadata = await ready
  return {
    metadata,
    packets,
    async stop() { child.stdin.end('stop\n'); await completed; return packets },
    /** QPC times are directly comparable with qpcMs() in Node on Windows. */
    summarize(startMs, endMs = qpcMs()) { return summarizePackets(packets, startMs, endMs, metadata.rate) }
  }
}

export function summarizePackets(packets, startMs, endMs, rate = 48000) {
  const selected = packets.filter((p) => p.qpcMs + p.frames * 1000 / rate >= startMs && p.qpcMs <= endMs)
  const active = selected.filter((p) => p.firstFrame >= 0 && !(p.flags & 4))
  return {
    packetCount: selected.length,
    timestampErrors: selected.filter((p) => p.flags & 4).length,
    discontinuities: selected.filter((p) => p.flags & 1).length,
    firstOutputQpcMs: active.length ? Math.min(...active.map((p) => p.qpcMs + p.firstFrame * 1000 / rate)) : null,
    lastOutputQpcMs: active.length ? Math.max(...active.map((p) => p.qpcMs + (p.lastFrame + 1) * 1000 / rate)) : null,
    peak: Math.max(0, ...selected.map((p) => p.peak)),
    observationEndQpcMs: selected.length ? Math.max(...selected.map((p) => p.qpcMs + p.frames * 1000 / rate)) : null
  }
}
