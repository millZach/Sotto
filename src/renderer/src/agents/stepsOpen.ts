import { useState } from 'react'

/**
 * Whether a turn's steps are open: the working line, the Worked for fold and the work folded into a Watcher reply's
 * header. Each starts folded and opens only on a press on its own line (Zach, November 15, 2026: only the one you click
 * unfolds). What the user chose is kept by thread and turn for this window's life, so a turn keeps it when its thread is
 * shown again, and a running turn's choice on its working line carries to its Worked for line or news header once it
 * ends. A press, Escape and Show where it asked set it; nothing else does. A turn ID can stand in from its user message,
 * so the thread is part of the key. A press on a group inside a turn is kept here too (`useGroupSteps`).
 */
export const stepsChoices = new Map<string, boolean>()
const turnKey = (threadId: string | undefined, turnId: string): string => `${threadId ?? ''}\n${turnId}`
/** Whether the user left this turn's steps open, folded when they never pressed it. */
export const stepsOpen = (threadId: string | undefined, turnId: string): boolean => stepsChoices.get(turnKey(threadId, turnId)) ?? false
export function chooseSteps(threadId: string | undefined, turnId: string, open: boolean): void { stepsChoices.set(turnKey(threadId, turnId), open) }

/** A press held while drawn and kept under `key` for the window's life; with no key, held only while drawn. */
function useKeptChoice(key: string | undefined): readonly [boolean | undefined, (open: boolean) => void] {
  const [pressed, setPressed] = useState<boolean | null>(null)
  return [pressed ?? (key === undefined ? undefined : stepsChoices.get(key)), open => { setPressed(open); if (key !== undefined) stepsChoices.set(key, open) }]
}

/** A finished turn's line: open as the user left this turn, and a press kept for it. */
export function useTurnSteps(threadId: string | undefined, turnId: string): readonly [boolean, (open: boolean) => void] {
  const [open, choose] = useKeptChoice(turnKey(threadId, turnId))
  return [open ?? false, choose]
}

/**
 * A group of a turn's steps ("Ran 2 commands"), the work its turn did after one reply: as the user left it, or undefined
 * when they never pressed it, so it starts as where it is drawn says. A press is kept by thread, turn and reply for the
 * window's life, as a turn's is, so a group stays as it was left when the thread is shown again or its turn is drawn
 * again, such as once an agent that went on working on its own stops, and when its oldest steps leave the thread's
 * history. Without a thread a press holds only while the group is drawn.
 */
export function useGroupSteps(threadId: string | undefined, turnId: string, anchorMessageId: string | null): readonly [boolean | undefined, (open: boolean) => void] {
  return useKeptChoice(threadId === undefined ? undefined : `${turnKey(threadId, turnId)}\ngroup\n${anchorMessageId ?? ''}`)
}
