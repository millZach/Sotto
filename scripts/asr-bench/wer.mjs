// Word-error-rate scoring for the ASR benchmark.
//
// The hypotheses come from two very different kinds of system:
//   - dedicated ASR models (Moonshine, Whisper) that emit verbatim words
//   - multimodal LLMs that "helpfully" format as they transcribe
//
// Sotto runs an LLM polish pass *after* transcription, so formatting choices
// ("$4,217" vs "four thousand two hundred seventeen") are not accuracy errors —
// they are the next stage's job. Scoring raw strings would rank the LLMs far
// below their real quality, so normalization folds formatting before scoring
// and both sides get the identical treatment.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

// Spells an integer so digit output and spoken output collapse to one form.
function spellInteger(n) {
  if (n < 20) return ONES[n]
  if (n < 100) return (TENS[Math.floor(n / 10)] + ' ' + (n % 10 ? ONES[n % 10] : '')).trim()
  if (n < 1000) {
    return (ONES[Math.floor(n / 100)] + ' hundred ' + (n % 100 ? spellInteger(n % 100) : '')).trim()
  }
  for (const [limit, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= limit) {
      return (spellInteger(Math.floor(n / limit)) + ' ' + word + ' ' +
        (n % limit ? spellInteger(n % limit) : '')).trim()
    }
  }
  return String(n)
}

// "2:15" reads as "two fifteen"; "4:45" as "four forty five".
function spellClock(h, m) {
  const minutes = m === 0 ? "o'clock" : m < 10 ? 'oh ' + spellInteger(m) : spellInteger(m)
  return spellInteger(h) + ' ' + minutes
}

export function normalize(text) {
  let s = (text ?? '').toLowerCase()

  // Strip a leading "here is the transcript:"-style preamble some LLMs add.
  s = s.replace(/^\s*(here'?s?\s+(is\s+)?)?(the\s+)?(verbatim\s+)?transcript(ion)?\s*[:\-–]\s*/i, '')
  s = s.replace(/^\s*sure[,!.]?\s*/i, '')

  // Common spoken/written equivalences, applied to both sides.
  s = s.replace(/\ba\.?\s*m\.?\b/g, 'am').replace(/\bp\.?\s*m\.?\b/g, 'pm')
  s = s.replace(/\bpercent\b/g, '%')

  // Clock times before generic numbers so "2:15" is not read as two numbers.
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => spellClock(Number(h), Number(m)))

  // Currency: "$4,217" -> "four thousand two hundred seventeen dollars".
  s = s.replace(/\$\s?([\d,]+(?:\.\d+)?)/g, (_, num) => {
    const n = Number(num.replace(/,/g, ''))
    return Number.isFinite(n) ? spellInteger(Math.round(n)) + ' dollars' : num
  })

  // Ordinals: "3rd" -> "third".
  const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 12: 'twelfth' }
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, num) => {
    const n = Number(num)
    return ORDINALS[n] ?? (spellInteger(n).replace(/y$/, 'ie') + 'th')
  })

  // Bare integers, including grouped thousands.
  s = s.replace(/\b\d[\d,]*\b/g, (m) => {
    const n = Number(m.replace(/,/g, ''))
    if (!Number.isFinite(n)) return m
    // Year-like 4-digit numbers read as pairs: 2026 -> "twenty twenty six".
    if (/^\d{4}$/.test(m) && n >= 1100 && n <= 2999) {
      return spellInteger(Math.floor(n / 100)) + ' ' + (n % 100 === 0 ? 'hundred' : spellInteger(n % 100))
    }
    return spellInteger(n)
  })

  // Punctuation -> space (hyphens and slashes split compounds too).
  s = s.replace(/[^\p{L}\p{N}\s']/gu, ' ')
  s = s.replace(/'/g, '')

  // "and" inside spelled numbers ("two hundred and seventeen") is optional in
  // English; dropping it from both sides avoids scoring a stylistic choice.
  const tokens = s.split(/\s+/).filter(Boolean).filter((w) => w !== 'and')
  return tokens
}

// "riverbank" vs "river bank" is an orthographic choice, not a mishearing, but
// plain token Levenshtein charges it as a substitution *plus* a deletion. Where
// one side joins two words the other splits, split the joined side so both
// describe the same utterance. Applied symmetrically, so no model gains from it.
function reconcileCompounds(a, b) {
  const out = []
  for (let i = 0, j = 0; i < a.length; i++) {
    const merged = b[j] !== undefined && b[j + 1] !== undefined ? b[j] + b[j + 1] : null
    if (a[i] === merged) {
      out.push(b[j], b[j + 1])
      j += 2
      continue
    }
    out.push(a[i])
    if (a[i] === b[j]) j++
    else j++
  }
  return out
}

// Levenshtein over word tokens.
export function wer(reference, hypothesis) {
  let ref = normalize(reference)
  let hyp = normalize(hypothesis)
  // Split whichever side joined a compound the other side spelled as two words.
  ref = reconcileCompounds(ref, hyp)
  hyp = reconcileCompounds(hyp, ref)
  if (ref.length === 0) return { wer: hyp.length ? 1 : 0, errors: hyp.length, refWords: 0 }

  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = ref[i - 1] === hyp[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1])
    }
    prev = cur
  }
  const errors = prev[hyp.length]
  return { wer: errors / ref.length, errors, refWords: ref.length }
}

// Which reference words the hypothesis missed — used to explain *why* a model
// scores badly (e.g. always the proper nouns).
export function missedWords(reference, hypothesis) {
  const hyp = new Set(normalize(hypothesis))
  return normalize(reference).filter((w) => !hyp.has(w))
}
