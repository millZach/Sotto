// The spoken lines, made with Windows' own speech synthesis. They feed Chromium's fake microphone, so Sotto
// records real audio and its level meter moves; the voice itself is never heard in the film.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './stage.mjs'

export const LINES = {
  hook: 'Add a dark mode toggle to the settings page.',
  anywhere: 'Oat milk, basil, and the good coffee.',
}

/** Writes <name>.wav (16 kHz mono PCM, with a little silence either side) and returns its path and length in ms. */
export function speak(name) {
  mkdirSync(paths.audio, { recursive: true })
  const file = join(paths.audio, `${name}.wav`)
  const script = join(paths.audio, `${name}.ps1`)
  writeFileSync(script, `Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.Rate = 0
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voice.SetOutputToWaveFile('${file}', $format)
$prompt = New-Object System.Speech.Synthesis.PromptBuilder
$prompt.AppendBreak([TimeSpan]::FromMilliseconds(300))
$prompt.AppendText('${LINES[name].replaceAll("'", "''")}')
$prompt.AppendBreak([TimeSpan]::FromMilliseconds(500))
$voice.Speak($prompt)
$voice.Dispose()
`, 'utf8')
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  return { file, ms: Math.round(Number(probe) * 1000) }
}
