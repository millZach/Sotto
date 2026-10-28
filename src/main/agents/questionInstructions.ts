/**
 * What a thread is told about asking the user (ADR-0005, ADR-0080): a question that needs the user's answer goes through
 * the provider's own question tool, which Sotto shows as a question card, and not only into a reply, which a finished
 * turn folds away. A decision that holds up shipping is one of those questions (#1715 sat finished 185 minutes on a
 * "say when"). Each provider adds it to its own instructions; it replaces nothing the provider says.
 * `keepsWorking` is for a tool whose question leaves the turn running (Codex's request_user_input in Default mode).
 */
export function questionInstructions(tool: string, keepsWorking: boolean): string {
  return `Ask actionable clarification questions through ${tool} so Sotto can show its question panel. Use it for questions with choices and free-text questions${keepsWorking ? ', including while continuing independent work' : ''}. Do not leave questions that need a user answer only in commentary or a final message. A suggested choice is not an answer. If an answer is required before an action, wait for the user before that action. A decision that holds up shipping, such as whether to ship, which take to keep or whether to approve an ADR change, is such a question: ask it there with its choices, never as a closing line such as "say when". Permission requests still use the native approval flow.`
}
