/**
 * What a thread is told about asking the user (ADR-0005, ADR-0080): a question that needs the user's answer goes through
 * the provider's own question tool, which Sotto shows as a question card, and not only into a reply, which a finished
 * turn folds away. A decision that holds up shipping is one of those questions (#1715 sat finished 185 minutes on a
 * "say when"). So is a prototype the user must look at (ADR-0108, November 6, 2026): its question card, which links the
 * page, is what asks them. What the user must read before answering goes in the reply or the question, never only in thinking.
 * Each provider adds it to its own instructions; it replaces nothing the provider says.
 * `keepsWorking` is for a tool whose question leaves the turn running (Codex's request_user_input in Default mode).
 */
export function questionInstructions(tool: string, keepsWorking: boolean): string {
  return `Ask actionable clarification questions through ${tool} so Sotto can show its question panel. Use it for questions with choices and free-text questions${keepsWorking ? ', including while continuing independent work' : ''}. Do not leave questions that need a user answer only in commentary or a final message. The question panel shows only the question and its choices, and the user never sees your thinking: write what they must read before they answer, such as commands or steps, as reply text before you ask, or in the question itself. A suggested choice is not an answer. If an answer is required before an action, wait for the user before that action. A decision that holds up shipping, such as whether to ship, which take to keep or whether to approve an ADR change, is such a question: ask it there with its choices, never as a closing line such as "say when". When a prototype or mock-up needs the user to look at it or pick between its variants, ask that as a question too, with the page's file path in this folder or its loopback address in the question, so the card links it: a prototype named only in a reply does not ask them. Permission requests still use the native approval flow.`
}

/**
 * What a thread is told about a Markdown file it makes (ADR-0120, November 3 amendment): a link opens it in Sotto's side panel,
 * so the user can read it without leaving the thread. Each provider that takes Sotto's instructions adds it to them, while its
 * Owl answer is on; it replaces nothing the provider says.
 */
export const MARKDOWN_LINK_INSTRUCTIONS = 'Whenever you write or change a Markdown file, or name one the user may want to read, link it in your reply by its full path inside angle brackets, with forward slashes, as in [plan.md](</full/path/to/plan.md>) or on Windows [plan.md](<D:/My Project/plan.md>). The brackets keep a path with spaces a link. Sotto opens that link in a side panel beside the thread, read only.'
