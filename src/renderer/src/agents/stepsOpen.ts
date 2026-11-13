import { useState } from 'react'

/**
 * Whether a turn's steps start open: the working line, the Worked for fold, the groups inside it and Watcher's news
 * work. Each one starts from the last one the user pressed, in every thread and after a restart, and then holds its own
 * state: a press on one never moves another already on screen.
 */
export const STEPS_OPEN_KEY = 'sotto.threads.stepsOpen'
/**
 * Running turns whose working line the user opened or folded, by thread and turn, so the line keeps that state when its
 * thread is shown again and the turn's Worked for line or news header starts as the line was left once the turn ends, for
 * this window's life. A press sets it, and so does Escape, which folds that turn alone; a press on the finished turn's
 * own line clears it. A turn ID can stand in from its user message, so the thread is part of the key.
 */
export const workingLineChoices = new Map<string, boolean>()
const turnKey = (threadId: string | undefined, turnId: string): string => `${threadId ?? ''}\n${turnId}`
export const workingLineChoice = (threadId: string | undefined, turnId: string): boolean | undefined => workingLineChoices.get(turnKey(threadId, turnId))
export function chooseWorkingLine(threadId: string | undefined, turnId: string, open: boolean): void { workingLineChoices.set(turnKey(threadId, turnId), open) }
export function forgetWorkingLine(threadId: string | undefined, turnId: string): void { workingLineChoices.delete(turnKey(threadId, turnId)) }
/** What the user last chose when storage refused to keep it. */
let unsaved: boolean | null = null

/** The answer as it stands now. */
export function readStepsOpen(): boolean {
  if (unsaved !== null) return unsaved
  try { return localStorage.getItem(STEPS_OPEN_KEY) === 'true' } catch { return false }
}

/** The answer as it stood when this line first showed; a later press elsewhere does not move it. */
export function useStepsStart(): boolean {
  return useState(readStepsOpen)[0]
}

/**
 * Called only from a press on a fold. Escape folds only the one it is in, since it is also how a pane beside Watcher is
 * put away, and a fold that opens itself sets nothing.
 */
export function setStepsOpen(open: boolean): void {
  if (open === readStepsOpen()) return
  try { localStorage.setItem(STEPS_OPEN_KEY, String(open)); unsaved = null } catch { unsaved = open }
}
