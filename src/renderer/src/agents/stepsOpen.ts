/**
 * Whether a turn's steps are open: the working line, the Worked for fold and the work folded into a Watcher reply's
 * header. Each starts folded and opens only on a press on its own line (Zach, November 15, 2026: only the one you click
 * unfolds). What the user chose is kept by thread and turn for this window's life, so a turn keeps it when its thread is
 * shown again, and a running turn's choice on its working line carries to its Worked for line or news header once it
 * ends. A press, Escape and Show where it asked set it; nothing else does. A turn ID can stand in from its user message,
 * so the thread is part of the key.
 */
export const stepsChoices = new Map<string, boolean>()
const turnKey = (threadId: string | undefined, turnId: string): string => `${threadId ?? ''}\n${turnId}`
/** Whether the user left this turn's steps open, folded when they never pressed it. */
export const stepsOpen = (threadId: string | undefined, turnId: string): boolean => stepsChoices.get(turnKey(threadId, turnId)) ?? false
export function chooseSteps(threadId: string | undefined, turnId: string, open: boolean): void { stepsChoices.set(turnKey(threadId, turnId), open) }
