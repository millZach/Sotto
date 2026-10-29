import { MAX_ACTIVITY_TEXT, THINKING_TITLE, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import { thinkingSettledAs } from './thinkingActivity'

export const CLAUDE_THINKING_ID_PREFIX = 'claude-thinking-'
/** A thinking block is known by its reply and its place in it, which the stream and the transcript both name. */
export const claudeThinkingId = (reply: string, index: number): string => `${CLAUDE_THINKING_ID_PREFIX}${reply}-${index}`
/** Content blocks that hold the model's thinking. A redacted one carries no words Sotto can show, only that it thought. */
export const THINKING_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])
/** The last length-delimited `field` of a protobuf message, or nothing when the bytes do not read as one. */
function protobufField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  let at = 0; let found: Uint8Array | undefined
  const varint = (): number => {
    let value = 0
    for (let shift = 0; at < bytes.length && shift < 35; shift += 7) { const byte = bytes[at++]!; value += (byte & 0x7f) * 2 ** shift; if (byte < 0x80) return value }
    throw new Error('varint')
  }
  try {
    while (at < bytes.length) {
      const tag = varint(); const wire = tag % 8
      if (wire === 0) varint()
      else if (wire === 1) at += 8
      else if (wire === 5) at += 4
      else if (wire === 2) { const length = varint(); if (at + length > bytes.length) return undefined; if (Math.floor(tag / 8) === field) found = bytes.subarray(at, at + length); at += length }
      else return undefined
    }
  } catch { return undefined }
  return found
}
/**
 * Whether a thinking block is narration: the server's stand-in for prose the model wrote to the user between tool
 * calls, which it returns in place of a text block. The kind is tagged inside the block's signature (field 2, then 1,
 * then 8), where Claude Code itself reads it; the transcript keeps no other mark. Its words are the server's summary of
 * that prose, or nothing when the request asked for no thinking text. An unreadable signature is ordinary thinking.
 */
export function claudeNarration(block: Record<string, unknown>): boolean {
  if (block.type !== 'thinking' || typeof block.signature !== 'string' || !block.signature) return false
  const envelope = protobufField(Buffer.from(block.signature, 'base64'), 2)
  const kind = envelope && protobufField(envelope, 1)
  const name = kind && protobufField(kind, 8)
  return name !== undefined && Buffer.from(name).toString('utf8') === 'narration'
}
/** How many streams' replies, open blocks and streamed replies are remembered; the oldest gives way past this. */
const MAX_REMEMBERED = 64

/**
 * Where a Thinking row sits and when it started: its turn, the message before it, its parent agent and its clock.
 * It is fixed when the block starts, so a block settled later stays on the turn it belongs to.
 */
type ThinkingPlace = Pick<AgentActivity, 'turnId' | 'sequence' | 'afterMessageId' | 'startedAt' | 'timingSource' | 'parentId'>

/** A Thinking row. Thinking is the model's own, so it names no folder. */
export function claudeThinkingRow(place: ThinkingPlace, id: string, status: AgentActivity['status'], words: string, extra: Partial<AgentActivity> = {}): AgentActivity {
  return { ...place, id, kind: 'reasoning', title: THINKING_TITLE, status, ...thinkingText(words), ...extra }
}

/** `restarted` marks a block started again over its own row, at the same place in the same reply. */
type OpenBlock = { readonly id: string; readonly stream: string; words: string; signature: string; readonly place: ThinkingPlace; readonly restarted: boolean }

/**
 * Claude's thinking blocks as they stream. A stream is the thread's own (`main`) or a subagent's, by its tool call.
 * Each block opens a Thinking row at its `content_block_start`, grows it with each `thinking_delta` and settles it at
 * its stop. A block nothing more will come for settles: its stream started another reply, its turn ended, its
 * subagent's result came back, or the CLI ended. A subagent launched to run in the background outlives the turn
 * that launched it, so only the notification that ends its task, or the CLI ending, settles its blocks.
 */
export class ClaudeThinking {
  /** The reply each stream is writing now, from its `message_start`. */
  private readonly replies = new Map<string, string>()
  /** Blocks started and not yet stopped, by stream and block index. */
  private readonly open = new Map<string, OpenBlock>()
  /** Replies whose thinking the stream showed, so the live frame repeating a finished block is not needed. */
  private readonly streamed = new Set<string>()
  /** Subagent streams launched to run on in the background, by their launching tool call. */
  private readonly background = new Set<string>()

  /** Whether the stream already showed this reply's thinking. */
  showed(reply: string): boolean { return this.streamed.has(reply) }

  /** A stream starts a reply. A block its last reply left open gets nothing more. */
  replyStarted(stream: string, reply: string, at: string | undefined): AgentActivity[] {
    const rows = this.settle((_key, block) => block.stream === stream, 'interrupted', at)
    this.replies.delete(stream); this.replies.set(stream, reply)
    for (const old of this.replies.keys()) { if (this.replies.size <= MAX_REMEMBERED) break; this.replies.delete(old) }
    return rows
  }

  /** A thinking block starts: its row shows now, before any of its words, and with whatever words it opened on. */
  started(stream: string, index: number, opening: unknown, place: ThinkingPlace): AgentActivity[] {
    const reply = this.replies.get(stream); if (!reply) return []
    const key = `${stream}:${index}`; const id = claudeThinkingId(reply, index)
    // The same place started again in the same reply keeps its row, since that row's id is the one the transcript
    // gives the block that finished there. Any other block left open at this place gets nothing more.
    const prior = this.open.get(key); const restarted = prior?.id === id
    const rows = restarted ? [] : this.settle(open => open === key, 'interrupted', place.startedAt)
    const block: OpenBlock = { id, stream, words: typeof opening === 'string' ? opening.slice(0, MAX_ACTIVITY_TEXT + 1) : '', signature: '', place: restarted ? prior.place : place, restarted }
    this.open.set(key, block); this.streamed.add(reply)
    for (const old of this.streamed) { if (this.streamed.size <= MAX_REMEMBERED) break; this.streamed.delete(old) }
    for (const old of this.open.keys()) { if (this.open.size <= MAX_REMEMBERED) break; rows.push(...this.settle(open => open === old, 'interrupted', place.startedAt)) }
    rows.push(this.row(block, 'running'))
    return rows
  }

  /** More words for an open block. One character past the budget is kept so the row can say its text was cut. */
  grew(stream: string, index: number, words: string): AgentActivity[] {
    const block = this.open.get(`${stream}:${index}`); if (!block) return []
    block.words = (block.words + words).slice(0, MAX_ACTIVITY_TEXT + 1)
    return [this.row(block, 'running')]
  }

  /** More of an open block's signature, which says at its end whether the block was narration. */
  signed(stream: string, index: number, signature: string): void {
    const block = this.open.get(`${stream}:${index}`); if (block) block.signature += signature
  }

  /**
   * A block stops. Only a thinking block has a row to settle. Narration is the reply's words rather than thinking, so
   * its row goes: its id comes back in `narration` and the reply's message carries the words.
   */
  stopped(stream: string, index: number, at: string | undefined, narration?: Set<string>): AgentActivity[] {
    const key = `${stream}:${index}`; const block = this.open.get(key)
    if (block && narration && claudeNarration({ type: 'thinking', signature: block.signature })) { this.open.delete(key); narration.add(block.id); return [] }
    return this.settle(open => open === key, 'completed', at)
  }

  /**
   * The thread's turn ended with `status`. Its own stream's open blocks, and those of any subagent it ran in the
   * foreground, get nothing more; its next reply starts afresh.
   */
  turnEnded(status: AgentActivity['status'], at: string | undefined): AgentActivity[] {
    this.replies.delete('main')
    return this.settle((_key, block) => !this.background.has(block.stream), thinkingSettledAs(status), at)
  }

  /** A subagent's launch came back saying it runs on in the background, past the turn that launched it. */
  detached(stream: string): void {
    this.background.add(stream)
    for (const old of this.background) { if (this.background.size <= MAX_REMEMBERED) break; this.background.delete(old) }
  }

  /** A subagent's stream ended, by its result or its task's end: its open blocks get nothing more. */
  streamEnded(stream: string, status: AgentActivity['status'], at: string | undefined): AgentActivity[] {
    this.replies.delete(stream); this.background.delete(stream)
    return this.settle((_key, block) => block.stream === stream, status, at)
  }

  /** The CLI ended: no stream will say anything more about any block. */
  ended(at: string): AgentActivity[] {
    this.replies.clear(); this.background.clear()
    return this.settle(() => true, 'interrupted', at)
  }

  private settle(which: (key: string, block: OpenBlock) => boolean, status: AgentActivity['status'], at: string | undefined): AgentActivity[] {
    const rows: AgentActivity[] = []
    for (const [key, block] of this.open) {
      if (!which(key, block)) continue
      this.open.delete(key)
      rows.push(this.row(block, status, at ? { completedAt: at } : {}))
    }
    return rows
  }

  /** A restarted block says outright what its words are now, so the first attempt's words do not stay on its row. */
  private row(block: OpenBlock, status: AgentActivity['status'], extra: Partial<AgentActivity> = {}): AgentActivity {
    const words = block.restarted ? { text: block.words.slice(0, MAX_ACTIVITY_TEXT), truncated: block.words.length > MAX_ACTIVITY_TEXT } : {}
    return claudeThinkingRow(block.place, block.id, status, block.words, { ...words, ...extra })
  }
}
