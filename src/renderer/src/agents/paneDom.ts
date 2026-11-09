export const THREAD_PROMPT_ID = 'thread-workspace-prompt'

/** Each pane's composer needs its own element ID once two are on screen; the single view keeps the established one. */
export function threadPromptId(threadId: string): string {
  return `${THREAD_PROMPT_ID}-${threadId}`
}

export const paneDomId = (threadId: string): string => `thread-pane-${threadId}`
export const tabDomId = (threadId: string): string => `thread-pane-tab-${threadId}`

/** Put keyboard focus inside a pane: its composer when it can take text, its terminal, otherwise its transcript. */
export function focusInPane(threadId: string): void {
  const pane = document.getElementById(paneDomId(threadId))
  const target = pane?.querySelector<HTMLElement>('.thread-workspace__compose :is(.prompt-editor[contenteditable="true"], textarea:not(:disabled))') ?? pane?.querySelector<HTMLElement>('.terminal-view textarea, [role="log"]')
  target?.focus()
}
