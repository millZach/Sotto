/** The Help topics another page may open Help at; each is the id of its topic on the Help page. */
export const HELP_TOPICS = ['help-watcher'] as const
export type HelpTopicId = (typeof HELP_TOPICS)[number]

export function isHelpTopic(value: string | undefined): value is HelpTopicId {
  return (HELP_TOPICS as readonly string[]).includes(value ?? '')
}

/** Help asked for at one topic, once per press: `key` changes with each request. */
export interface HelpRequest { readonly topic: HelpTopicId; readonly key: number }
