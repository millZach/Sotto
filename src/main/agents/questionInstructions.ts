/**
 * What a thread is told about asking the user (ADR-0005, ADR-0080): a question that needs the user's answer goes through
 * the provider's own question tool, which Sotto shows as a question card, and not only into a reply, which a finished
 * turn folds away. What the user must read before answering goes in the reply or the question, never only in thinking.
 * Each provider adds it to its own instructions; it replaces nothing the provider says.
 * `keepsWorking` is for a tool whose question leaves the turn running (Codex's request_user_input in Default mode).
 */
export function questionInstructions(tool: string, keepsWorking: boolean): string {
  return `Ask actionable clarification questions through ${tool} so Sotto can show its question panel. Use it for questions with choices and free-text questions${keepsWorking ? ', including while continuing independent work' : ''}. Do not leave questions that need a user answer only in commentary or a final message. The question panel shows only the question and its choices, and the user never sees your thinking: write what they must read before they answer, such as commands or steps, as reply text before you ask, or in the question itself. A suggested choice is not an answer. If an answer is required before an action, wait for the user before that action. Permission requests still use the native approval flow.`
}
