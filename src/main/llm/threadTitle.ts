import type { AppSettings } from '../../shared/settings'
import { settingsGatedWriter, type ShortTextRequest, type ShortTextWriter } from './shortTextWriter'

/** A sidebar row and a pane heading both have to hold the whole title. */
export const THREAD_TITLE_MAX_CHARACTERS = 60

/** Each half of the exchange is cut to this before it is sent; a title needs the opening, not the whole reply. */
const EXCHANGE_EXCERPT_CHARACTERS = 2_000

/** The first exchange of a thread: what the user asked, and what the agent answered. */
export interface ThreadTitleExchange {
  readonly prompt: string
  readonly reply: string
}

const INSTRUCTION = [
  'You name a coding conversation for a sidebar.',
  'Answer with the name alone: no quotes, no punctuation at the end, no explanation.',
  `Use at most ${THREAD_TITLE_MAX_CHARACTERS} characters, in the language of the conversation.`,
  'Name the work itself, concretely, the way a person would write it on a task list.',
  'Do not start with words like "Help with", "Discussion about", "Chat" or "Thread".',
].join(' ')

/**
 * The title request: the first user message and the first reply are all the
 * model is given, so nothing later in the thread can reach OpenRouter through
 * the name of a thread.
 */
export function threadTitleRequest(exchange: ThreadTitleExchange): ShortTextRequest {
  return {
    purpose: 'thread-title',
    instruction: INSTRUCTION,
    material: [
      `First message:\n${excerpt(exchange.prompt)}`,
      `First reply:\n${excerpt(exchange.reply)}`,
    ].join('\n\n'),
    maxCharacters: THREAD_TITLE_MAX_CHARACTERS,
    maxTokens: 64,
  }
}

/** What the coordinator calls to name a thread; see `settingsGatedWriter` for the off switch. */
export function threadTitleWriter(
  writer: Pick<ShortTextWriter, 'write'>,
  getSettings: () => AppSettings | Promise<AppSettings>,
): (exchange: ThreadTitleExchange) => Promise<string | null> {
  return settingsGatedWriter(writer, getSettings, { enabled: settings => settings.threadTitles, request: threadTitleRequest })
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= EXCHANGE_EXCERPT_CHARACTERS ? trimmed : trimmed.slice(0, EXCHANGE_EXCERPT_CHARACTERS)
}
