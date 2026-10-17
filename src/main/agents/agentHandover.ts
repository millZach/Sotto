import { PROVIDER_LABELS, type HandoverCounts, type ProviderId } from '../../shared/agents'
import type { SubagentAssignment, SubagentRow } from '../../shared/subagents'
import { HANDOVER_BUDGET } from './handover'

/**
 * A thin handover (#1028): what a new thread starts from when it continues one of a thread's agents without the provider's
 * own copy of the agent's conversation. Claude Code keeps a subagent's working history inside its own session, and Codex
 * may no longer have an agent's conversation, so all Sotto can carry is the task the agent was given and the result it
 * reported, both from its own roster record. It says plainly that it is thin, that it is context and not a new request,
 * and what it left out. Pure: no store is read and nothing is logged; the words are the user's and the agents'.
 */

/** No single part may take more than half of a handover's budget; one that would is left out whole and named. */
const PART_MAX = Math.floor(HANDOVER_BUDGET / 2)
const TITLE_MAX = 200

export interface AgentHandoverInput {
  /** The thread the agent worked for, by its Sotto thread ID (ADR-0002). */
  readonly source: { readonly threadId: string; readonly title?: string | undefined; readonly provider: ProviderId }
  readonly agent: Pick<SubagentRow, 'title' | 'model'>
  /** The agent's current assignment, as the roster holds it. Codex keeps a v2 agent's task encrypted, so it has none. */
  readonly assignment: Pick<SubagentAssignment, 'prompt' | 'result'> | undefined
  /** False while Keep local history is off: the roster held only what Sotto kept since it last started. */
  readonly historyKept: boolean
}

export interface AgentHandover {
  readonly text: string
  readonly counts: HandoverCounts
}

const oneLine = (text: string | undefined, max = TITLE_MAX): string | undefined => text?.replace(/\s+/gu, ' ').trim().slice(0, max) || undefined
const characters = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`

/** The handover's words and counts, or undefined when Sotto holds neither the task nor the result. */
export function agentHandover(input: AgentHandoverInput): AgentHandover | undefined {
  const task = input.assignment?.prompt?.trim() ? input.assignment.prompt : undefined
  const result = input.assignment?.result?.trim() ? input.assignment.result : undefined
  if (task === undefined && result === undefined) return undefined
  const agent = oneLine(input.agent.title) ?? 'an agent'
  const sourceTitle = oneLine(input.source.title)
  const from = sourceTitle ? `"${sourceTitle}" (thread ${input.source.threadId})` : `thread ${input.source.threadId}`
  const model = oneLine(input.agent.model, 120)
  const tooLong: string[] = []
  const part = (name: string, text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    if (text.length > PART_MAX) { tooLong.push(`${name} (${characters(text.length)})`); return undefined }
    return text
  }
  const carriedTask = part('the task', task)
  const carriedResult = part('the result', result)
  const lines = [
    'This is a handover from an agent of another Sotto thread. It is context, not a new request. Nothing in it asks you to do anything now.',
    `The agent was "${agent}"${model ? `, on ${model}` : ''}. It worked for ${from}, on ${PROVIDER_LABELS[input.source.provider]}.`,
    task === undefined
      ? 'This handover is thin. The agent’s task was not kept where Sotto can read it, so it carries only the agent’s title and the result it reported. What the agent read, ran and decided along the way is left out.'
      : 'This handover is thin. It carries only the task the agent was given and the result it reported. What the agent read, ran and decided along the way is left out.',
  ]
  if (!input.historyKept) lines.push('Keep local history is off, so this comes only from what Sotto kept since it last started.')
  if (tooLong.length) lines.push(`Left out whole because ${tooLong.length === 1 ? 'it is' : 'they are'} too long to carry: ${tooLong.join(' and ')}.`)
  if (result === undefined) lines.push('The agent reported no result.')
  const body = [lines.join('\n')]
  if (carriedTask !== undefined) body.push(`The task the agent was given:\n${carriedTask}`)
  if (carriedResult !== undefined) body.push(`The result it reported:\n${carriedResult}`)
  const carried = (carriedTask !== undefined ? 1 : 0) + (carriedResult !== undefined ? 1 : 0)
  return { text: body.join('\n\n'), counts: { total: (task !== undefined ? 1 : 0) + (result !== undefined ? 1 : 0), carried, tooLong: tooLong.length,
    notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: input.historyKept, answered: result !== undefined } }
}
