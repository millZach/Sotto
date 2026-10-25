import { msg } from '@lingui/core/macro'

import { threadSummaryOf, type AgentProject, type AgentState, type AgentThread } from '../../../shared/agents'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import { wordsOf } from './interfaceWords'

/**
 * What a new thread says above its composer until the first send: one line, picked at random the first time the
 * thread is seen and kept for as long as the window is open, so switching away and back does not change it.
 */
export const GREETINGS: readonly string[] = [
  'What’s on your mind?',
  'Ready when you are.',
  'Let’s make something.',
  'What are we building?',
  'Where should we start?',
  'What’s the plan?',
  'Got something in mind?',
  'What needs fixing?',
  'Let’s get into it.',
  'Point me at a problem.',
  'Something to build, fix or figure out?',
]

/** The lines that join the pool only at their own time of day. */
export function timedGreetings(hour: number): readonly string[] {
  if (hour >= 5 && hour < 12) return ['Morning. What’s first?']
  if (hour >= 17 && hour < 22) return ['Evening. What’s left?']
  if (hour >= 22 || hour < 5) return ['Up late. What are we making?']
  return []
}

/**
 * Each line in the interface language. A thread keeps its line by its English words, so a change of language
 * shows the same line in the new language rather than picking another.
 */
const GREETING_WORDS: Readonly<Record<string, string>> = wordsOf({
  'What’s on your mind?': msg`What’s on your mind?`,
  'Ready when you are.': msg`Ready when you are.`,
  'Let’s make something.': msg`Let’s make something.`,
  'What are we building?': msg`What are we building?`,
  'Where should we start?': msg`Where should we start?`,
  'What’s the plan?': msg`What’s the plan?`,
  'Got something in mind?': msg`Got something in mind?`,
  'What needs fixing?': msg`What needs fixing?`,
  'Let’s get into it.': msg`Let’s get into it.`,
  'Point me at a problem.': msg`Point me at a problem.`,
  'Something to build, fix or figure out?': msg`Something to build, fix or figure out?`,
  'Morning. What’s first?': msg`Morning. What’s first?`,
  'Evening. What’s left?': msg`Evening. What’s left?`,
  'Up late. What are we making?': msg`Up late. What are we making?`,
})

/** A greeting as the window shows it, in the interface language. */
export function greetingWords(line: string): string {
  return Object.hasOwn(GREETING_WORDS, line) ? GREETING_WORDS[line]! : line
}

/** One line from the pool for this hour, never `avoid` when there is another to choose. */
export function pickGreeting(hour: number, random: () => number, avoid?: string): string {
  const all = [...GREETINGS, ...timedGreetings(hour)]
  const pool = all.filter(line => line !== avoid)
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? all[0]!
}

const chosen = new Map<string, string>()
let lastChosen: string | undefined

/** This thread's greeting. Two new threads in a row never open on the same line, and a timed line outlives its hour by
 * no more than the next time the thread is drawn. */
export function greetingFor(threadId: string, now: Date = new Date(), random: () => number = Math.random): string {
  const known = chosen.get(threadId)
  if (known !== undefined && (GREETINGS.includes(known) || timedGreetings(now.getHours()).includes(known))) return known
  const line = pickGreeting(now.getHours(), random, lastChosen)
  chosen.set(threadId, line)
  lastChosen = line
  return line
}

/**
 * The projects a new thread's greeting offers to start in instead: the others on the same host, newest work first, up
 * to `limit`. A project counts as used when one of its threads has a time; settled projects and the current one are left out.
 */
export function recentProjects(state: Pick<AgentState, 'host'>, thread: Pick<AgentThread, 'id' | 'hostId' | 'projectId'>, limit = 5): AgentProject[] {
  const hostIdOf = (entity: { readonly id: string; readonly hostId?: string | undefined }): string | undefined => entity.hostId ?? parseHostEntityKey(entity.id)?.hostId
  const hostId = hostIdOf(thread)
  const latest = new Map<string, number>()
  for (const item of state.host.threads) {
    const at = Date.parse(item.updatedAt ?? threadSummaryOf(item).lastMessageAt ?? '')
    if (Number.isFinite(at) && at > (latest.get(item.projectId) ?? -Infinity)) latest.set(item.projectId, at)
  }
  return state.host.projects
    .filter(project => project.id !== thread.projectId && latest.has(project.id) && hostIdOf(project) === hostId && !project.workspaceSettledAt)
    .sort((a, b) => latest.get(b.id)! - latest.get(a.id)!)
    .slice(0, limit)
}
