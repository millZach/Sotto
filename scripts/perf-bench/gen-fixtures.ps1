# Generates deterministic TTS speech fixtures for the inference benchmark.
# Output: scripts/perf-bench/fixtures/speech-{tiny,short,long}.wav (16 kHz mono PCM16)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force $dir | Out-Null

Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$clips = @{
  'speech-tiny.wav'  = 'Send the email now.'
  'speech-short.wav' = 'The quick brown fox jumps over the lazy dog near the river bank.'
  'speech-long.wav'  = 'Dictation software converts spoken words into written text in real time. People use it to write emails, documents, and messages without touching the keyboard. The best systems feel instant, accurate, and completely effortless to use every single day.'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  foreach ($entry in $clips.GetEnumerator()) {
    $synth.SetOutputToWaveFile((Join-Path $dir $entry.Key), $format)
    $synth.Speak($entry.Value)
  }
} finally {
  $synth.Dispose()
}
Get-ChildItem $dir
