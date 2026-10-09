import type { TerminalProvider } from '../../shared/terminalWorkspace'

/** A bounded active screen, with no scrollback. Neither this screen nor its contents leave main. */
export class TerminalAgentScreen {
  private primary: string[][]
  private alternate: string[][] | undefined
  private primaryWrap: boolean[]
  private alternateWrap: boolean[] | undefined
  private x = 0
  private y = 0
  private saved = { x: 0, y: 0 }
  private primaryCursor = { x: 0, y: 0 }
  private top = 0
  private bottom: number
  private pending = ''
  private discardedString = false
  private valid = true
  constructor(private cols: number, private rows: number) { this.primary = this.blank(); this.primaryWrap = Array<boolean>(rows).fill(false); this.bottom = rows - 1 }
  private blank(): string[][] { return Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' ')) }
  private get cells(): string[][] { return this.alternate ?? this.primary }
  private get wraps(): boolean[] { return this.alternateWrap ?? this.primaryWrap }
  /** A resize waits for a redraw rather than treating truncated old content as a fresh prompt. */
  resize(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows; this.primary = this.blank(); this.alternate = undefined
    this.primaryWrap = Array<boolean>(rows).fill(false); this.alternateWrap = undefined
    this.x = this.y = this.top = 0; this.bottom = rows - 1; this.valid = false
  }
  private scroll(count = 1): void {
    for (let n = 0; n < Math.min(count, this.rows); n++) {
      this.cells.splice(this.top, 1); this.cells.splice(this.bottom, 0, Array<string>(this.cols).fill(' '))
      this.wraps.splice(this.top, 1); this.wraps.splice(this.bottom, 0, false)
    }
  }
  private reverseScroll(count = 1): void {
    for (let n = 0; n < Math.min(count, this.rows); n++) {
      this.cells.splice(this.bottom, 1); this.cells.splice(this.top, 0, Array<string>(this.cols).fill(' '))
      this.wraps.splice(this.bottom, 1); this.wraps.splice(this.top, 0, false)
    }
  }
  private down(): void { if (this.y === this.bottom) this.scroll(); else this.y = Math.min(this.rows - 1, this.y + 1) }
  private eraseLine(mode: number): void {
    const row = this.cells[this.y]!
    const start = mode === 1 || mode === 2 ? 0 : Math.min(this.x, this.cols - 1)
    const end = mode === 0 || mode === 2 ? this.cols : Math.min(this.x + 1, this.cols)
    row.fill(' ', start, end)
    this.wraps[this.y] = false
  }
  private csi(sequence: string, final: string): void {
    const privateMode = sequence.startsWith('?')
    const args = sequence.replace(/^[?>]/u, '').split(';').map(value => Number.parseInt(value, 10) || 0)
    const first = args[0] ?? 0, count = first || 1
    if (privateMode && (final === 'h' || final === 'l')) {
      for (const mode of args) if ([47, 1047, 1049].includes(mode)) {
        if (final === 'h' && !this.alternate) { this.primaryCursor = { x: this.x, y: this.y }; this.alternate = this.blank(); this.alternateWrap = Array<boolean>(this.rows).fill(false); this.x = this.y = 0 }
        if (final === 'l' && this.alternate) { this.alternate = undefined; this.alternateWrap = undefined; this.x = this.primaryCursor.x; this.y = this.primaryCursor.y }
      }
      return
    }
    switch (final) {
      case 'A': this.y = Math.max(this.top, this.y - count); break
      case 'B': case 'e': this.y = Math.min(this.bottom, this.y + count); break
      case 'C': case 'a': this.x = Math.min(this.cols - 1, this.x + count); break
      case 'D': this.x = Math.max(0, this.x - count); break
      case 'E': this.y = Math.min(this.bottom, this.y + count); this.x = 0; break
      case 'F': this.y = Math.max(this.top, this.y - count); this.x = 0; break
      case 'G': case '`': this.x = Math.min(this.cols - 1, Math.max(0, count - 1)); break
      case 'd': this.y = Math.min(this.rows - 1, Math.max(0, count - 1)); break
      case 'H': case 'f': this.y = Math.min(this.rows - 1, Math.max(0, count - 1)); this.x = Math.min(this.cols - 1, Math.max(0, (args[1] || 1) - 1)); if (this.x === 0 && this.y === 0) this.valid = true; break
      case 'J':
        if (first === 2 || first === 3) { for (const row of this.cells) row.fill(' '); this.wraps.fill(false); this.valid = true }
        else {
          this.eraseLine(first)
          const start = first === 1 ? 0 : this.y + 1, end = first === 1 ? this.y : this.rows
          for (let row = start; row < end; row++) { this.cells[row]!.fill(' '); this.wraps[row] = false }
        }
        break
      case 'K': this.eraseLine(first); break
      case 'X': this.cells[this.y]!.fill(' ', this.x, Math.min(this.cols, this.x + count)); break
      case 'P': this.cells[this.y]!.splice(this.x, count); while (this.cells[this.y]!.length < this.cols) this.cells[this.y]!.push(' '); break
      case '@': this.cells[this.y]!.splice(this.x, 0, ...Array<string>(Math.min(count, this.cols)).fill(' ')); this.cells[this.y]!.length = this.cols; break
      case 'S': this.scroll(count); break
      case 'T': this.reverseScroll(count); break
      case 'L': for (let n = 0; n < Math.min(count, this.rows); n++) { this.cells.splice(this.y, 0, Array<string>(this.cols).fill(' ')); this.cells.splice(this.bottom + 1, 1); this.wraps.splice(this.y, 0, false); this.wraps.splice(this.bottom + 1, 1) }; break
      case 'M': for (let n = 0; n < Math.min(count, this.rows); n++) { this.cells.splice(this.y, 1); this.cells.splice(this.bottom, 0, Array<string>(this.cols).fill(' ')); this.wraps.splice(this.y, 1); this.wraps.splice(this.bottom, 0, false) }; break
      case 'r': this.top = Math.max(0, Math.min(this.rows - 1, count - 1)); this.bottom = Math.max(this.top, Math.min(this.rows - 1, (args[1] || this.rows) - 1)); this.x = 0; this.y = this.top; break
      case 's': this.saved = { x: this.x, y: this.y }; break
      case 'u': this.x = this.saved.x; this.y = this.saved.y; break
      // SGR, cursor visibility, bracketed paste and terminal queries do not write screen text.
      case 'm': case 'h': case 'l': case 'n': case 'c': case 'q': case 't': break
      default: this.valid = false
    }
  }
  write(chunk: string): void {
    if (this.discardedString) {
      // ANSI string terminators are ESC backslash and BEL, not printable screen content.
      // eslint-disable-next-line no-control-regex
      const end = /\x1b\\|\x07/u.exec(this.pending + chunk)
      if (!end) { this.pending = chunk.endsWith('\x1b') ? '\x1b' : ''; return }
      chunk = (this.pending + chunk).slice(end.index + end[0].length); this.pending = ''; this.discardedString = false
    }
    const data = this.pending + chunk; this.pending = ''
    for (let index = 0; index < data.length;) {
      const char = data[index]!
      if (char === '\x1b') {
        if (index + 1 >= data.length) { this.pending = data.slice(index); break }
        const next = data[index + 1]!
        if (next === '[') {
          // The screen parser deliberately matches the ANSI CSI byte grammar.
          // eslint-disable-next-line no-control-regex
          const match = /^\x1b\[([\x20-\x3f]*)([\x40-\x7e])/u.exec(data.slice(index))
          if (!match) { this.pending = data.slice(index, index + 256); if (data.length - index > 256) { this.pending = ''; this.valid = false }; break }
          this.csi(match[1]!, match[2]!); index += match[0].length; continue
        }
        if ([']', 'P', '_', '^', 'X'].includes(next)) {
          // Discard OSC/DCS strings through their control-byte terminator.
          // eslint-disable-next-line no-control-regex
          const rest = data.slice(index + 2), end = /\x1b\\|\x07/u.exec(rest)
          if (!end) { if (data.length - index > 8192) { this.discardedString = true; this.pending = data.endsWith('\x1b') ? '\x1b' : '' } else this.pending = data.slice(index); break }
          index += 2 + end.index + end[0].length; continue
        }
        if (next === '7') this.saved = { x: this.x, y: this.y }
        else if (next === '8') { this.x = this.saved.x; this.y = this.saved.y }
        else if (next === 'D') this.down()
        else if (next === 'E') { this.x = 0; this.down() }
        else if (next === 'M') { if (this.y > this.top) this.y--; else this.reverseScroll() }
        else if (next === 'c') { this.primary = this.blank(); this.alternate = undefined; this.primaryWrap.fill(false); this.alternateWrap = undefined; this.x = this.y = this.top = 0; this.bottom = this.rows - 1; this.valid = true }
        else if (['(', ')', '*', '+', '%', '#'].includes(next)) { if (index + 2 >= data.length) { this.pending = data.slice(index); break }; index++ }
        index += 2; continue
      }
      index++
      if (char === '\r') { this.x = 0; continue }
      if (char === '\n' || char === '\v' || char === '\f') { this.wraps[this.y] = false; this.down(); continue }
      if (char === '\b') { this.x = Math.max(0, this.x - 1); continue }
      if (char === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); continue }
      if (char < ' ' || char === '\x7f') continue
      let printed = char
      if (/[\uD800-\uDBFF]/u.test(char)) {
        if (index === data.length) { this.pending = char; break }
        if (/[\uDC00-\uDFFF]/u.test(data[index]!)) printed += data[index++]
      }
      if (/\p{Mark}/u.test(printed)) { if (this.x > 0) this.cells[this.y]![this.x - 1] += printed; continue }
      const code = printed.codePointAt(0)!
      const width = code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1
      if (this.x + width > this.cols) { this.wraps[this.y] = true; this.x = 0; this.down() }
      this.cells[this.y]![this.x++] = printed
      if (width === 2) this.cells[this.y]![this.x++] = ''
    }
  }
  lines(): string[] { return this.cells.map(row => row.join('').trimEnd()) }
  /** Join only rows the emulator itself soft-wrapped; explicit newline boundaries remain strict rule anchors. */
  logicalLines(limit = this.rows): string[] {
    const lines = this.lines(), last = lines.findLastIndex(line => line.trim() !== '')
    const start = Math.max(0, last - limit + 1), result: string[] = []
    for (let row = start; row <= last; row++) {
      const content = this.wraps[row] ? this.cells[row]!.join('') : lines[row]!
      if (row > start && this.wraps[row - 1]) result[result.length - 1] += content
      else result.push(content)
    }
    return result
  }
  get reliable(): boolean { return this.valid && this.pending.length === 0 && !this.discardedString }
}

export interface TerminalScreenEvidence {
  detection: 'available' | 'unavailable'
  /** An identified unsupported CLI admits the activity fallback without claiming recognised readiness. */
  unsupportedVersion?: boolean
  /** Meaningful unversioned screen content admits output activity without permanently resolving startup. */
  unresolvedVersion?: boolean
  state?: 'working' | 'idle' | 'needs-you'
  failed?: boolean
}

/** Each compatibility entry is deliberately a single checked CLI version, never an optimistic version range. */
export const TERMINAL_SCREEN_RULES = { claude: '2.1.295', codex: '0.162.0', grok: '1.0.50' } as const

export class TerminalScreenRules {
  private version: string | undefined
  constructor(private readonly provider: TerminalProvider) {}
  /** Whether the CLI's own banner named the version these rules were checked against; undefined until a banner names one. */
  get supported(): boolean | undefined { return this.version === undefined ? undefined : this.version === TERMINAL_SCREEN_RULES[this.provider] }
  read(screen: TerminalAgentScreen): TerminalScreenEvidence {
    const all = screen.logicalLines()
    const header = all.join('\n')
    const version = this.provider === 'claude' ? /Claude Code\s+v?(\d+\.\d+\.\d+)/u.exec(header)?.[1]
      : this.provider === 'codex' ? /(?:OpenAI )?Codex\s*\(v(\d+\.\d+\.\d+)\)/u.exec(header)?.[1]
      : /Grok Build(?: \(pager\))?\s*(?:-\s*)?v?(\d+\.\d+\.\d+)/u.exec(header)?.[1]
    if (version) this.version = version
    if (!screen.reliable || this.version !== TERMINAL_SCREEN_RULES[this.provider]) return {
      detection: 'unavailable',
      ...(this.version && this.version !== TERMINAL_SCREEN_RULES[this.provider] ? { unsupportedVersion: true } : {}),
      ...(!this.version && screen.reliable && all.some(line => line.trim() !== '') ? { unresolvedVersion: true } : {}),
    }
    // Blank space below the cursor is not scrollback. Read only the active screen's final twelve nonempty rows.
    const bottom = screen.logicalLines(12).map(line => line.trim())
    const text = bottom.join('\n')
    // Approval chrome must own the current footer, not an example above a live draft or later output.
    const footer = bottom.at(-1) ?? ''
    const failed = /^(?:Error:|Interrupted|Cancelled|Canceled|Turn cancelled|Turn canceled|Request failed)/imu.test(text)
    if (this.provider === 'claude') {
      const work = /(?:esc to interrupt|ctrl\+c to interrupt)/iu.test(text) && /^[✶✻✽✢·*]\s+\S.+/mu.test(text)
      if (work) return { detection: 'available', state: 'working', failed }
      if (bottom.slice(-4).some(line => /^❯\s*$/u.test(line)) && /(?:^|\s)\? for shortcuts(?:\s+[·|].*)?$/iu.test(bottom.at(-1) ?? '')) return { detection: 'available', state: 'idle', failed }
      const choices = /^(?:❯\s*)?1\.\s+Yes(?:,|$)/mu.test(text) && /^(?:❯\s*)?[2-9]\.\s+No(?:,|$)/mu.test(text)
        && /^❯\s*[1-9]\.\s+\S.+/mu.test(text)
      const prompt = /^(?:Do you want to proceed\?|Allow .+\?|Do you want to .+\?)$/mu.test(text)
      const controls = /(?:Enter to confirm|Esc to cancel|esc to cancel)/u.test(footer)
      if (choices && prompt && controls) return { detection: 'available', state: 'needs-you' }
      // The bundled 2.1.295 AskUserQuestion component uses numbered choices, its built-in Other row and select/navigation/cancel chrome.
      const questionChoices = /^❯\s*\d+\.\s+\S.+/mu.test(text) && /^\d+\.\s+(?:Type something\.?|Chat about this)$/mu.test(text)
      const questionControls = /enter to select/iu.test(footer) && /(?:↑\/↓ to navigate|Tab\/Arrow keys to navigate)/iu.test(footer) && /(?:esc|escape) to cancel/iu.test(footer)
      if (questionChoices && questionControls) return { detection: 'available', state: 'needs-you' }
    } else if (this.provider === 'codex') {
      // The native status row owns an elapsed clock and interrupt hint. Reduced motion omits its leading activity bullet.
      const work = /^(?:•\s+)?[\p{L}\p{N}][^()>\r\n]*\((?:\d+h \d{2}m \d{2}s|\d+m \d{2}s|\d+s) • esc to interrupt\)(?: • \S.*)?$/mu.test(text)
      if (work) return { detection: 'available', state: 'working', failed }
      if (bottom.slice(-4).some(line => /^›\s*(?:Ask Codex to do anything)?$/u.test(line)) && /(?:^|\s)\? for shortcuts(?:\s+\d+% context left)?$/iu.test(bottom.at(-1) ?? '')) return { detection: 'available', state: 'idle', failed }
      const prompt = /^(?:Would you like to run the following command\?|Would you like to make the following edits\?|Would you like to apply these changes\?)$/mu.test(text)
      const choices = /^(?:›\s*)?1\.\s+Yes, proceed(?:\s|$)/mu.test(text) && /^(?:›\s*)?[2-9]\.\s+No, and tell Codex .+/mu.test(text)
        && /^›\s*[1-9]\.\s+\S.+/mu.test(text)
      const controls = /^Press enter to confirm or esc to cancel$/iu.test(footer)
      if (prompt && choices && controls) return { detection: 'available', state: 'needs-you' }
      // Codex rust-v0.162.0 request_user_input has a progress header, selected choice/freeform input, and its own submission footer.
      const questionHeader = /^Question \d+\/\d+(?: \(\d+ unanswered\))?(?: · auto-resolves in .+)?$/mu.test(text)
      const questionInput = /^›\s*(?:\d+\.\s+\S.+|Type your answer \(optional\))$/mu.test(text)
      const questionControls = /(?:enter|⌃\w(?: enter)?) to submit (?:answer|all)/iu.test(footer) && /(?:esc|⌃c) to interrupt/iu.test(footer)
      if (questionHeader && questionInput && questionControls) return { detection: 'available', state: 'needs-you' }
    } else {
      // Grok 1.0.50's prompt is a bordered input, with its model/mode footer. Escape never cancels work.
      // The current turn_status widget has a braille spinner, phase timer and [stop] button; historical Thinking blocks lack this chrome.
      const work = /^[\u2801-\u28ff]\s+(?:Thinking…|Responding…|Verifying…|Waiting…|Run command)\s+\d+(?:\.\d+)?s\s+.*\[stop\]$/mu.test(text)
      if (work) return { detection: 'available', state: 'working', failed }
      const prompt = bottom.some(line => /^[│┃]\s*>\s*[│┃]?$/u.test(line))
      if (prompt && bottom.slice(-2).some(line => /^Grok .+\s·\s(?:auto-review|ask|always-approve|plan)/iu.test(line))) return { detection: 'available', state: 'idle', failed }
      // Blocking cards have a native accent rail; the final shortcuts row contains complete key:label hints separated by light rails.
      const hints = (bottom.at(-1) ?? '').split(/\s+│\s+/u)
      const nativeHints = hints.every(hint => /^[\p{L}\p{N}↑↓←→?/][^:\s>│]*:\s*[^>│\s][^>│]*$/u.test(hint))
      const permissionHint = nativeHints && (hints.some(hint => /^Tab\/Space:\s*permission$/u.test(hint))
        || hints.some(hint => /^1\/[1-9]:\s*select$/u.test(hint)) && hints.some(hint => /^Tab:\s*next option$/u.test(hint)))
      const permissionTitle = /^[│┃]\s+Allow \S.+\?$/mu.test(text)
      const choices = /^[│┃]\s+[1-9]\s+\([○●•]\)\s+(?:Yes(?:, (?:proceed|allow once|send once))?|allow once)$/imu.test(text)
        && /^[│┃]\s+[1-9]\s+\([○●•]\)\s+No, reject \(type to add feedback\)$/mu.test(text)
      if (permissionTitle && choices && permissionHint) return { detection: 'available', state: 'needs-you' }
      // Native question cards share that rail, with shortcut/radio/checkbox answer rows and the installed Other input label.
      const questionChoices = /^[│┃]\s+[1-9a-z]\s+(?:\([○●•]\)|\[[ x]\])\s+\S.+/mu.test(text)
      const questionInput = /^[│┃]\s+(?:(?:[1-9a-z]\s+)?(?:\([○●•]\)|\[[ x]\])\s+)?Other \(type your own answer\)$/mu.test(text)
      const questionHint = nativeHints && hints.some(hint => /^(?:Tab\/Space:\s*question|Tab:\s*next answer)$/u.test(hint))
      if (questionChoices && questionInput && questionHint) return { detection: 'available', state: 'needs-you' }
    }
    return { detection: 'unavailable', failed }
  }
}
