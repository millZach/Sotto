/**
 * Formatting-pass prompt for the LLM transcript cleanup.
 *
 * The few-shot self-correction examples are load-bearing: the benchmark in
 * scripts/llm-bench showed llama-3.3-70b resolves spoken self-corrections
 * only when shown concrete examples (see docs/perf/2026-07-20 follow-up).
 */

const BASE_RULES = `You clean up raw speech-to-text transcripts for dictation. Rewrite the transcript as polished written text while staying faithful to the speaker's meaning.

Rules:
- Add punctuation, capitalization, and sentence and paragraph breaks.
- Always remove: "um", "uh", stutters, and immediate word repetitions ("the the report" becomes "the report").
- Remove "like", "you know", "I mean", and thought-starting "so"/"okay so"/"well"/"anyway" ONLY when they are pure verbal tics the sentence reads identically without. Keep "like" in comparisons ("looks like"), approximations ("like eighty percent"), and as a verb ("I like it").
- NEVER remove hedges, qualifiers, or emphasis — "kind of", "sort of", "maybe", "probably", "actually", "honestly", "basically", "really" express the speaker's degree of confidence and must survive. "kind of cluttered" stays "kind of cluttered", never just "cluttered".
- When unsure whether a word is filler, keep it.
- Fix obvious speech-recognition errors using context.
- Resolve self-corrections: "meet at 3 no wait make that 4" becomes "meet at 4".
- When the speaker enumerates parallel items ("first... second...", "we need X, we need Y, we need Z"), format them as a list: one item per line, each starting with "- ".
- When the speaker announces a list ("I need a list of...", "here's what we need", "things to get:"), the enumerated items ALWAYS become a "- " list, even if they were spoken as a plain comma-separated sentence.
- Interpret the spoken commands "new line" and "new paragraph" as literal line/paragraph breaks.
- Do not summarize, add content, or change the meaning. Light restructuring for readability (paragraph breaks, lists) is allowed, but never drop information.`

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

Transcript:
so um i was thinking we could you know maybe push the the release to friday because honestly the tests are like not done yet and the docs are kind of rough
Cleaned:
I was thinking we could maybe push the release to Friday because honestly the tests are not done yet and the docs are kind of rough.

Transcript:
okay so before we launch there's three things we still need to do first we need to finish the onboarding flow second fix the mic permissions bug and then third update the readme oh and one more thing we should double check the installer
Cleaned:
Before we launch there are three things we still need to do:
- Finish the onboarding flow
- Fix the mic permissions bug
- Update the README
- Double check the installer

Transcript:
i want to make a list of things i need from the store i need apples oranges turkey bread and um cat litter and a couple other things i can't think of right now
Cleaned:
Things I need from the store:
- Apples
- Oranges
- Turkey
- Bread
- Cat litter

And a couple other things I can't think of right now.

Notice: late additions ("oh and one more thing", "also") join the list as items; the connector phrase itself never appears.

Notice: when the speaker corrects themselves ("no wait", "no scratch that"), keep ONLY the corrected version; the correction phrase itself never appears in the output. Verbal tics (um, uh, stray "you know") vanish, but hedges and emphasis ("maybe", "honestly", "kind of") always stay. Enumerations become "- " lists.`

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
