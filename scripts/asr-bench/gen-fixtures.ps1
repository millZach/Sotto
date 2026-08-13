# Generates deterministic TTS speech fixtures for the ASR accuracy benchmark.
# Extends scripts/perf-bench/fixtures with clips that stress the failure modes
# Moonshine is weakest on: technical vocabulary, proper nouns, numbers, and
# acronyms. Output: scripts/asr-bench/fixtures/*.wav (16 kHz mono PCM16)
# plus fixtures/ground-truth.json holding the reference transcripts.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force $dir | Out-Null

Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

# Ordered so the JSON ground truth is stable across runs.
$clips = [ordered]@{
  'tiny'      = 'Send the email now.'
  'short'     = 'The quick brown fox jumps over the lazy dog near the river bank.'
  'long'      = 'Dictation software converts spoken words into written text in real time. People use it to write emails, documents, and messages without touching the keyboard. The best systems feel instant, accurate, and completely effortless to use every single day.'
  'technical' = 'Sotto runs the Moonshine encoder through ONNX Runtime inside the Electron main process, so transcription never leaves the device. Whisper pads every clip to a thirty second window, which is why latency stays flat regardless of how short the utterance is.'
  'numbers'   = 'Transfer four thousand two hundred and seventeen dollars on March third, twenty twenty six. The invoice number is A B 4 7 dash 9 0 2, and the meeting moved from 2:15 to 4:45 p.m.'
  'propernoun'= 'Zache asked whether Wispr Flow or Superwhisper handles punctuation better than Otter and Descript. Ping Priya and Sowmya on the Anthropic thread before the Kubernetes migration starts.'
  'homophone' = 'They are going to accept the new principle, not the interest rate principal. Their advice affects the effect we expected, and it is too late to buy two more.'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  foreach ($entry in $clips.GetEnumerator()) {
    $path = Join-Path $dir "speech-$($entry.Key).wav"
    $synth.SetOutputToWaveFile($path, $format)
    $synth.Speak($entry.Value)
  }
} finally {
  $synth.Dispose()
}

# Ground truth alongside the audio so the benchmark never hardcodes references.
$truth = [ordered]@{}
foreach ($entry in $clips.GetEnumerator()) { $truth[$entry.Key] = $entry.Value }
$truth | ConvertTo-Json | Out-File -FilePath (Join-Path $dir 'ground-truth.json') -Encoding utf8

Get-ChildItem $dir
