import { MAX_ACTIVITY_TEXT, THINKING_TITLE, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import { thinkingSettledAs } from './thinkingActivity'

export const CLAUDE_THINKING_ID_PREFIX = 'claude-thinking-'
/** A thinking block is known by its reply and its place in it, which the stream and the transcript both name. */
export const claudeThinkingId = (reply: string, index: number): string => `${CLAUDE_THINKING_ID_PREFIX}${reply}-${index}`
/** Content blocks that hold the model's thinking. A redacted one carries no words Sotto can show, only that it thought. */
export const THINKING_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])
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

type OpenBlock = { readonly id: string; words: string; readonly place: ThinkingPlace }

/**
 * Claude's thinking blocks as they stream. A stream is the thread's own (`main`) or a subagent's, by its tool call.
 * Each block opens a Thinking row at its `content_block_start`, grows it with each `thinking_delta` and settles it at
 * its stop. A block nothing more will come for settles as interrupted: its stream started another reply, the same
 * place was started again, its turn failed or was stopped, or the CLI ended.
 */
export class ClaudeThinking {
  /** The reply each stream is writing now, from its `message_start`. */
  private readonly replies = new Map<string, string>()
  /** Blocks started and not yet stopped, by stream and block index. */
  private readonly open = new Map<string, OpenBlock>()
  /** Replies whose thinking the stream showed, so the live frame repeating a finished block is not needed. */
  private readonly streamed = new Set<string>()

  /** Whether the stream already showed this reply's thinking. */
  showed(reply: string): boolean { return this.streamed.has(reply) }

  /** A stream starts a reply. A block its last reply left open gets nothing more. */
  replyStarted(stream: string, reply: string, at: string | undefined): AgentActivity[] {
    const rows = this.settle(key => key.startsWith(`${stream}:`), 'interrupted', at)
    this.replies.delete(stream); this.replies.set(stream, reply)
    for (const old of this.replies.keys()) { if (this.replies.size <= MAX_REMEMBERED) break; this.replies.delete(old) }
    return rows
  }

  /** A thinking block starts: its row shows now, before any of its words, and with whatever words it opened on. */
  started(stream: string, index: number, opening: unknown, place: ThinkingPlace): AgentActivity[] {
    const reply = this.replies.get(stream); if (!reply) return []
    const key = `${stream}:${index}`
    const rows = this.settle(open => open === key, 'interrupted', place.startedAt)
    const block: OpenBlock = { id: claudeThinkingId(reply, index), words: typeof opening === 'string' ? opening.slice(0, MAX_ACTIVITY_TEXT + 1) : '', place }
    this.open.set(key, block); this.streamed.add(reply)
    for (const old of this.streamed) { if (this.streamed.size <= MAX_REMEMBERED) break; this.streamed.delete(old) }
    for (const old of this.open.keys()) { if (this.open.size <= MAX_REMEMBERED) break; rows.push(...this.settle(open => open === old, 'interrupted', place.startedAt)) }
    rows.push(claudeThinkingRow(block.place, block.id, 'running', block.words))
    return rows
  }

  /** More words for an open block. One character past the budget is kept so the row can say its text was cut. */
  grew(stream: string, index: number, words: string): AgentActivity[] {
    const block = this.open.get(`${stream}:${index}`); if (!block) return []
    block.words = (block.words + words).slice(0, MAX_ACTIVITY_TEXT + 1)
    return [claudeThinkingRow(block.place, block.id, 'running', block.words)]
  }

  /** A block stops. Only a thinking block has a row to settle. */
  stopped(stream: string, index: number, at: string | undefined): AgentActivity[] {
    const key = `${stream}:${index}`
    return this.settle(open => open === key, 'completed', at)
  }

  /** The thread's turn ended with `status`. Its own stream's open blocks get nothing more, and its next reply starts afresh. */
  turnEnded(status: AgentActivity['status'], at: string | undefined): AgentActivity[] {
    this.replies.delete('main')
    return this.settle(key => key.startsWith('main:'), thinkingSettledAs(status), at)
  }

  /** The CLI ended: no stream will say anything more about any block. */
  ended(at: string): AgentActivity[] {
    this.replies.clear()
    return this.settle(() => true, 'interrupted', at)
  }

  private settle(which: (key: string) => boolean, status: AgentActivity['status'], at: string | undefined): AgentActivity[] {
    const rows: AgentActivity[] = []
    for (const [key, block] of this.open) {
      if (!which(key)) continue
      this.open.delete(key)
      rows.push(claudeThinkingRow(block.place, block.id, status, block.words, at ? { completedAt: at } : {}))
    }
    return rows
  }
}
