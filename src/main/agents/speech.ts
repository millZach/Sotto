import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface AgentSpeechAudio { readonly audioBase64: string; readonly mimeType: 'audio/wav' }

const MAX_AUDIO_BYTES = 12 * 1024 * 1024
const SYNTHESIS_TIMEOUT_MS = 60_000

// Speech text is stdin data. It is never interpolated into PowerShell source.
const WINDOWS_SYNTHESIS = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$audio = New-Object System.IO.MemoryStream
try {
  $speech.SetOutputToWaveStream($audio)
  $speech.Speak([string]$request.text)
  $speech.SetOutputToNull()
  [Console]::Out.Write([Convert]::ToBase64String($audio.ToArray()))
} finally {
  $speech.Dispose()
  $audio.Dispose()
}
`

function runSpeechProcess(executable: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let failure: Error | null = null
    const timeout = setTimeout(() => {
      failure = new Error('Local speech generation timed out. Read the reply in the widget.')
      child.kill()
    }, SYNTHESIS_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_AUDIO_BYTES * 1.5) {
        failure = new Error('The spoken reply exceeds the local audio limit.')
        child.kill()
      } else chunks.push(chunk)
    })
    // Drain diagnostics without retaining or exposing text supplied to speech.
    child.stderr.resume()
    child.on('error', () => { failure = new Error('Local system speech is unavailable. Install a system voice and retry.') })
    child.stdin.on('error', () => { /* process exit supplies the user-facing failure */ })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (failure !== null) reject(failure)
      else if (code !== 0) reject(new Error('Local speech generation failed. Check your installed system voices.'))
      else resolveResult(Buffer.concat(chunks))
    })
    child.stdin.end(input, 'utf8')
  })
}

function validateWave(audio: Buffer): AgentSpeechAudio {
  if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The system voice returned invalid audio. Read the reply in the widget.')
  }
  return { audioBase64: audio.toString('base64'), mimeType: 'audio/wav' }
}

/** Generates local audio only; playback stays in the renderer that owns microphone suppression. */
export async function synthesizeAgentSpeech(text: string, platform: 'win32' | 'darwin'): Promise<AgentSpeechAudio> {
  if (text.trim().length === 0 || text.length > 2_000) throw new Error('Spoken replies must contain between 1 and 2,000 characters.')
  if (platform === 'win32') {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = await runSpeechProcess(executable,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SYNTHESIS, 'utf16le').toString('base64')],
      JSON.stringify({ text }))
    return validateWave(Buffer.from(result.toString('utf8').trim(), 'base64'))
  }

  const directory = await mkdtemp(join(tmpdir(), 'sotto-speech-'))
  const output = join(directory, 'reply.wav')
  try {
    await runSpeechProcess('/usr/bin/say', ['-o', output, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'], text)
    const metadata = await stat(output)
    if (metadata.size > MAX_AUDIO_BYTES) throw new Error('The spoken reply exceeds the local audio limit.')
    return validateWave(await readFile(output))
  } finally {
    const resolved = resolve(directory)
    if (dirname(resolved) === resolve(tmpdir()) && basename(resolved).startsWith('sotto-speech-')) {
      await rm(resolved, { recursive: true, force: true })
    }
  }
}
