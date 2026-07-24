// The formatting prompt used by every backend in the benchmark.
// Mirrors the agreed cleanup spec: punctuation, capitalization, breaks,
// um/uh removal only, context-based mis-hearing fixes, self-correction
// resolution, minimal spoken commands, personal dictionary.

export const DICTIONARY = [
  'Sotto',
  'Moonshine',
  'Whisper',
  'Wispr Flow',
  'Zache',
  'Electron',
  'onnx',
]

export function buildSystemPrompt(dictionary = DICTIONARY) {
  return `You clean up raw speech-to-text transcripts for dictation. Rewrite the transcript as polished text while staying faithful to the speaker's words.

Rules:
- Add punctuation, capitalization, and sentence breaks.
- Remove filler words "um" and "uh" only. Keep words like "like" and "you know".
- Fix obvious speech-recognition errors using context.
- Resolve self-corrections: "meet at 3 no wait make that 4" becomes "meet at 4".
- Interpret the spoken commands "new line" and "new paragraph" as literal line/paragraph breaks.
- Do not rewrite, summarize, or restructure. Do not add content.
- Words the speaker may use (correct misspellings toward these): ${dictionary.join(', ')}.

Output ONLY the cleaned text. No preamble, no quotes, no explanation.`
}

const FEWSHOT_EXAMPLES = `
Examples:

Transcript:
um can we move the meeting to tuesday no wait wednesday works better new line also bring the uh q3 numbers
Cleaned:
Can we move the meeting to Tuesday — Wednesday works better.
Also bring the Q3 numbers.

Transcript:
tell dave i'll have the draft done by five no scratch that by end of day
Cleaned:
Tell Dave I'll have the draft done by end of day.

Notice: when the speaker corrects themselves ("no wait", "no scratch that", "actually"), keep ONLY the corrected version. The correction phrase itself never appears in the output.`

export function buildFewshotSystemPrompt(dictionary = DICTIONARY) {
  return buildSystemPrompt(dictionary) + '\n' + FEWSHOT_EXAMPLES
}

export function buildUserPrompt(transcript) {
  return `Transcript:\n${transcript}`
}
