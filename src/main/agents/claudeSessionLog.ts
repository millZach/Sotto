import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { CLAUDE_MAX_FRAME_BYTES, object, type ClaudeFrame } from './claudeProtocol'

export const claudeDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
export function claudeText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(block => object(block)).filter(block => block?.type === 'text').map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : ''
}
export function authoredClaudeUser(frame: ClaudeFrame): boolean {
  if (frame.type !== 'user' || frame.isMeta === true || frame.isSynthetic === true || frame.isCompactSummary === true || frame.is_compact_summary === true || frame.isSidechain === true || frame.parent_tool_use_id) return false
  // Claude Code files its own turns, such as a finished background task, as user entries with an origin; a typed prompt has none.
  const origin = object(frame.origin)?.kind
  if (origin !== undefined && origin !== 'user') return false
  const content = object(frame.message)?.content
  if (Array.isArray(content) && content.some(block => object(block)?.type === 'tool_result')) return false
  // The native local-command envelope is operational metadata, not a prompt or takeover.
  if (/^\s*<command-name>\/compact<\/command-name>\s*<command-message>compact<\/command-message>\s*<command-args>[\s\S]*<\/command-args>\s*$/u.test(claudeText(content))) return false
  return !/^(?:<local-command-stdout>|<session-start-hook>|<task-notification>|<tick>|<goal>|\[Request interrupted by user|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/u.test(claudeText(content))
}

/**
 * Where a transcript had been read to when the reader last stopped, with the identity of the file it
 * was read from. `offset` sits on a line boundary, so resuming from it never splits an entry.
 */
export interface ClaudeTranscriptCursor { readonly offset: number; readonly size: number; readonly ino?: string | undefined; readonly birthtimeMs?: number | undefined }

function sameFile(cursor: ClaudeTranscriptCursor, identity: { ino?: string | undefined; birthtimeMs?: number | undefined }): boolean {
  if (cursor.ino || identity.ino) return Boolean(cursor.ino && identity.ino && cursor.ino === identity.ino)
  return cursor.birthtimeMs !== undefined && identity.birthtimeMs !== undefined && Math.abs(cursor.birthtimeMs - identity.birthtimeMs) < 1
}

/** Reads only a Sotto-created UUID in its known project; never discovers foreign history. */
export class ClaudeSessionLog {
  private offset = 0
  /** Bytes through the last complete line delivered: the only offset that is safe to store. */
  private line = 0
  private identity: { size: number; ino?: string | undefined; birthtimeMs?: number | undefined } | undefined
  private resumeFrom: ClaudeTranscriptCursor | undefined
  private remainder = ''
  private decoder = new StringDecoder('utf8')
  private pending: Promise<void> = Promise.resolve()
  private path: string | undefined
  /** `onSettled` runs once after each read that delivered entries, so a long catch-up costs one publish, not one per line. */
  constructor(private readonly home: string, private readonly cwd: string, private readonly sessionId: string, private readonly onEntry: (frame: ClaudeFrame) => void, private readonly onSettled?: () => void) {}
  async exists(): Promise<boolean> { const path = await this.resolve(); return Boolean(path && (await stat(path).catch(() => undefined))?.isFile()) }
  /** The session's folder beside its transcript, where Claude Code files its subagents' own transcripts. */
  async sessionFolder(): Promise<string | undefined> { const path = await this.resolve(); return path ? path.slice(0, -'.jsonl'.length) : undefined }
  /** Start the next read at a stored cursor instead of byte zero, while nothing has been read yet. */
  resume(cursor: ClaudeTranscriptCursor): void { if (!this.offset && !this.line) this.resumeFrom = cursor }
  /** The cursor to store for the next run, or nothing while no file has been read. */
  cursor(): ClaudeTranscriptCursor | undefined {
    return this.identity ? { offset: this.line, size: this.identity.size, ...(this.identity.ino ? { ino: this.identity.ino } : {}), ...(this.identity.birthtimeMs === undefined ? {} : { birthtimeMs: this.identity.birthtimeMs }) } : undefined
  }
  poll(): Promise<void> {
    const work = this.pending.then(() => this.read())
    this.pending = work.catch(() => undefined)
    return work
  }
  private async resolve(): Promise<string | undefined> {
    if (this.path) return this.path
    const projects = join(this.home, 'projects'); const folder = this.cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/gu, '-')
    const folders = folder.length <= 200 ? [folder] : (await readdir(projects).catch(() => [])).filter(name => name.startsWith(`${folder.slice(0, 200)}-`))
    for (const name of folders) {
      const candidate = join(projects, name, `${this.sessionId}.jsonl`)
      if ((await stat(candidate).catch(() => undefined))?.isFile()) { this.path = candidate; return candidate }
    }
    return undefined
  }
  private async read(): Promise<void> {
    const path = await this.resolve(); if (!path) return
    const handle = await open(path, 'r').catch(() => undefined); if (!handle) return
    let delivered = false
    try {
      const stats = await handle.stat()
      const size = stats.size
      // Some Windows filesystems report no inode; the creation time is then the only identity on offer.
      this.identity = { size, ...(stats.ino ? { ino: String(stats.ino) } : {}), ...(Number.isFinite(stats.birthtimeMs) ? { birthtimeMs: stats.birthtimeMs } : {}) }
      const resume = this.resumeFrom; this.resumeFrom = undefined
      if (resume && resume.offset <= size && size >= resume.size && sameFile(resume, this.identity)) { this.offset = resume.offset; this.line = resume.offset }
      if (size < this.offset) { this.offset = 0; this.line = 0; this.remainder = ''; this.decoder = new StringDecoder('utf8') }
      while (this.offset < size) {
        const bytes = Buffer.alloc(Math.min(64 * 1024, size - this.offset))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset)
        if (!bytesRead) break
        this.offset += bytesRead; this.remainder += this.decoder.write(bytes.subarray(0, bytesRead))
        let newline: number
        while ((newline = this.remainder.indexOf('\n')) >= 0) {
          const line = this.remainder.slice(0, newline); this.remainder = this.remainder.slice(newline + 1)
          this.line += Buffer.byteLength(line) + 1
          if (Buffer.byteLength(line) > CLAUDE_MAX_FRAME_BYTES) continue
          try {
            const entry = object(JSON.parse(line))
            if (entry && (!entry.sessionId || entry.sessionId === this.sessionId)) { this.onEntry(entry); delivered = true }
          } catch { /* Unrelated/malformed native metadata is not user input. */ }
        }
        if (Buffer.byteLength(this.remainder) > CLAUDE_MAX_FRAME_BYTES) throw new Error('Claude transcript entry exceeds the supported size.')
      }
    } finally {
      try { await handle.close() } finally { if (delivered) this.onSettled?.() }
    }
  }
}
