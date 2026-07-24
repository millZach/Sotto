/**
 * Formatting-pass prompt for the LLM transcript cleanup.
 *
 * The few-shot self-correction examples are load-bearing: the benchmark in
 * scripts/llm-bench showed llama-3.3-70b resolves spoken self-corrections
 * only when shown concrete examples (see docs/perf/2026-07-20 follow-up).
 */

const BASE_RULES = `You clean up raw speech-to-text transcripts for dictation. Rewrite the transcript as polished text while staying faithful to the speaker's words.

Rules:
- Add punctuation, capitalization, and sentence breaks.
- Remove filler words "um" and "uh" only. Keep words like "like" and "you know".
- Fix obvious speech-recognition errors using context.
- Resolve self-corrections: "meet at 3 no wait make that 4" becomes "meet at 4".
- Interpret the spoken commands "new line" and "new paragraph" as literal line/paragraph breaks.
- Do not rewrite, summarize, or restructure. Do not add content.`

const FEWSHOT_EXAMPLES = `Examples:

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

const OUTPUT_RULE = 'Output ONLY the cleaned text. No preamble, no quotes, no explanation.'

/** One dictionary word per line; blank lines and duplicates are dropped. */
export function parseDictionary(dictionary: string): readonly string[] {
  const seen = new Set<string>()
  for (const line of dictionary.split(/\r?\n/)) {
    const word = line.trim()
    if (word.length > 0 && word.length <= 64) seen.add(word)
  }
  return [...seen]
}

export function buildPolishSystemPrompt(dictionary: string): string {
  const words = parseDictionary(dictionary)
  const dictionaryRule =
    words.length === 0
      ? ''
      : `\n- Words the speaker may use (correct misspellings toward these): ${words.join(', ')}.`
  return `${BASE_RULES}${dictionaryRule}\n\n${OUTPUT_RULE}\n\n${FEWSHOT_EXAMPLES}`
}

export function buildPolishUserPrompt(transcript: string): string {
  return `Transcript:\n${transcript}`
}
