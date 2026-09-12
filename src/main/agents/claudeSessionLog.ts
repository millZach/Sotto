import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { object, type ClaudeFrame } from './claudeProtocol'

export const claudeDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
export function claudeText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(block => object(block)).filter(block => block?.type === 'text').map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : ''
}
export function authoredClaudeUser(frame: ClaudeFrame): boolean {
  if (frame.type !== 'user' || frame.isMeta === true || frame.isCompactSummary === true || frame.isSidechain === true || frame.parent_tool_use_id) return false
  const content = object(frame.message)?.content
  if (Array.isArray(content) && content.some(block => object(block)?.type === 'tool_result')) return false
  return !/^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user|\s*<ide_opened_file>|\s*<ide_selection>)/u.test(claudeText(content))
}

/** Reads only a Sotto-created UUID in its known project; never discovers foreign history. */
export class ClaudeSessionLog {
  private offset = 0
  private remainder = ''
  private decoder = new StringDecoder('utf8')
  private pending: Promise<void> = Promise.resolve()
  private path: string | undefined
  constructor(private readonly home: string, private readonly cwd: string, private readonly sessionId: string, private readonly onEntry: (frame: ClaudeFrame) => void) {}
  async exists(): Promise<boolean> { return Boolean(await this.resolve()) }
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
    try {
      const size = (await handle.stat()).size
      if (size < this.offset) { this.offset = 0; this.remainder = ''; this.decoder = new StringDecoder('utf8') }
      while (this.offset < size) {
        const bytes = Buffer.alloc(Math.min(64 * 1024, size - this.offset))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset)
        if (!bytesRead) break
        this.offset += bytesRead; this.remainder += this.decoder.write(bytes.subarray(0, bytesRead))
        let newline: number
        while ((newline = this.remainder.indexOf('\n')) >= 0) {
          const line = this.remainder.slice(0, newline); this.remainder = this.remainder.slice(newline + 1)
          if (Buffer.byteLength(line) > 1024 * 1024) continue
          try {
            const entry = object(JSON.parse(line))
            if (entry && (!entry.sessionId || entry.sessionId === this.sessionId)) this.onEntry(entry)
          } catch { /* Unrelated/malformed native metadata is not user input. */ }
        }
        if (Buffer.byteLength(this.remainder) > 1024 * 1024) throw new Error('Claude transcript entry exceeds the supported size.')
      }
    } finally { await handle.close() }
  }
}
