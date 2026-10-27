/**
 * Which code in a reply is a runnable command (ADR-0139), and the bytes a drawer shell receives for it. Pure, so the
 * window, preload and main read the same rule. What runs is the text the user sees, never an attribute.
 */

/** Fence languages that hold shell input. */
export const RUNNABLE_LANGUAGES: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'terminal', 'powershell', 'pwsh', 'ps1', 'cmd'])

// Every control character but newline: an ESC sequence or a carriage return could make the shell run something
// other than what the reply shows, and a tab typed into an interactive shell asks it to complete the word instead.
// Bidirectional controls can reorder what the eye reads, and invisible format characters (a zero-width space) or a
// line or paragraph separator make the bytes differ from what is drawn.
// eslint-disable-next-line no-control-regex -- Matching control characters is the point.
const FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]|\p{Bidi_Control}|\p{Cf}|\p{Zl}|\p{Zp}/u

/** Whether the text holds a character that could make what runs differ from what is shown. */
export function hasForbiddenControl(text: string): boolean { return FORBIDDEN.test(text) }

// Prompts in the order they are tried: `> ` is also how npm and yarn print a script's name, so it counts as a prompt
// only in a block where no line has the shell's own prompt.
const PROMPTS = [/^\$ /u, /^> /u]
// PowerShell's own prompt: `PS> ` or `PS C:\work> `.
const POWERSHELL_PROMPTS = [/^(?:\$ |PS(?: [^>\n]*)?> )/u, /^> /u]
const POWERSHELL = new Set(['powershell', 'pwsh', 'ps1'])
/** Languages that name a transcript rather than a script: without a prompt line they hold only output. */
const TRANSCRIPTS = new Set(['console', 'terminal'])
// A first word a shell can run: a path (`./`, `../`, `/`, `~/`) or a lower-case program name. A PowerShell cmdlet below.
const PATH_START = /^(?:\.{0,2}\/|~\/)/u
const FIRST_TOKEN = /^(?:(?:\.{0,2}\/|~\/)\S*|[a-z][\w.+-]*)$/u
// A PowerShell cmdlet, Verb-Noun: `Get-ChildItem`. Never a word of prose, so it runs alone too.
const CMDLET = /^[A-Z][a-z]+-[A-Z][A-Za-z]+$/u
// Code, not a command: a span that starts like a statement in JavaScript, TypeScript or Python.
const CODE_KEYWORDS: ReadonlySet<string> = new Set(['const', 'let', 'var', 'return', 'await', 'async', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'function', 'class', 'import', 'export', 'from', 'new', 'typeof', 'def', 'print', 'yield'])
// A call, `fetch(url)`: a word directly followed by a parenthesis. A shell's `$(…)` has no word before it.
const CALL = /\w\(/u

/** The command a fenced block runs, or null when its language is not a shell's or it cannot run as shown. */
export function runnableBlock(code: string, language: string | undefined): string | null {
  const lang = language?.trim().toLowerCase()
  if (!lang || !RUNNABLE_LANGUAGES.has(lang) || hasForbiddenControl(code)) return null
  let lines = code.split('\n')
  // A block with prompts is a transcript: only its prompted lines run, without the prompt; the rest is output.
  const prompt = (POWERSHELL.has(lang) ? POWERSHELL_PROMPTS : PROMPTS).find(candidate => lines.some(line => candidate.test(line)))
  if (prompt) lines = lines.filter(line => prompt.test(line)).map(line => line.replace(prompt, ''))
  else if (TRANSCRIPTS.has(lang)) return null
  const command = lines.join('\n').replace(/^\s*\n/u, '').trimEnd()
  return command.trim() ? command : null
}

/** The command an inline code span runs, or null when it reads as a name, a path or prose rather than a command. */
export function runnableInline(text: string): string | null {
  // Checked before trimming, which would quietly drop a trailing carriage return or newline.
  if (text.includes('\n') || hasForbiddenControl(text)) return null
  const command = text.trim()
  if (!command || /[›→]/u.test(command)) return null
  const first = command.split(/\s+/u)[0]!
  if (CALL.test(command)) return null
  if (CMDLET.test(first)) return command
  if (!FIRST_TOKEN.test(first) || CODE_KEYWORDS.has(first)) return null
  // A lone word (`true`, `santa`, `src/shared/owlFeatures.ts`) is a name, not a command; a lone path still runs.
  return /\s/u.test(command) || PATH_START.test(first) ? command : null
}

/** What the shell receives: each line ended with Enter, as if typed. */
export function terminalInputFor(command: string): string { return `${command.replace(/\n/gu, '\r')}\r` }
