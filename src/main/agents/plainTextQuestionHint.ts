const FENCED_CODE_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu
const CHOICE_PROMPT = /\b(?:question card|which\s+(?:option|one|variant|take|approach|path|way|choice)|pick\s+(?:one|between|an?\s+(?:option|variant|take))|choose\s+(?:one|between|an?\s+(?:option|variant))|select\s+(?:one|an?\s+option)|how\s+(?:would|should)\s+you\s+like\s+to\s+proceed|reply\s+with|let\s+me\s+know\s+which|prefer|would\s+you\s+like\s+(?:me\s+to|to)\s+(?:keep|ship|use|apply|go\s+with))\b/iu
const OPTION_LINE = /^\s*(?:[-*]\s+)?(?:\*{1,2})?(?:(?:\d{1,2}|[A-Za-z])[.)]|\[\d{1,2}\]|(?:Option|Variant|Take|Choice|Approach)\s+(?:\d{1,2}|[A-Za-z]))(?:\*{1,2})?(?:\s*[:—-]|\s+)/u
const CHECKLIST_LINE = /^\s*[-*]\s+\[[ xX]\]/u

export const PLAIN_TEXT_QUESTION_HINT = 'Note: this reply lists choices in plain text with no open question card; check whether to send the thread back to ask through its question card tool.'

/**
 * Detects finished worker replies whose tail presents a plain-text option menu / "question card" instead of calling the
 * provider's native card tool. Returns false for checklists, code blocks, and summaries without a choice prompt.
 */
export function looksLikePlainTextQuestionCard(replyText: string): boolean {
  if (!replyText.trim()) return false
  const stripped = replyText.replace(FENCED_CODE_BLOCK, '\n').trim()
  if (!stripped) return false
  const tail = stripped.slice(-2_000)
  const lines = tail.split(/\r?\n/u)
  let optionCount = 0
  for (const line of lines) {
    if (CHECKLIST_LINE.test(line)) continue
    if (OPTION_LINE.test(line)) optionCount++
  }
  if (optionCount < 2) return false
  return CHOICE_PROMPT.test(tail)
}
