/**
 * Where a prototype's pages were found (ADR-0108): a question waiting in the thread, by its request ID, or a reply, by
 * its message ID. QuestionPages keys its searches by it, and a Prototype ready mark names it as `source`. Written
 * `request:<ID>` or `reply:<message ID>`.
 */

/** The source of a question's pages. */
export const requestSource = (requestId: string): string => `request:${requestId}`
/** The source of a reply's pages. */
export const replySource = (messageId: string): string => `reply:${messageId}`
