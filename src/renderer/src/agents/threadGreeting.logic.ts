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
