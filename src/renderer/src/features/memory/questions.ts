import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import type { MemoryTopic } from '../../../../shared/memory'

/** Labels read in the interface language each time they are read, so a table kept at module level follows a change. */
function translated<K extends string>(messages: Readonly<Record<K, MessageDescriptor>>): Readonly<Record<K, string>> {
  const labels = {} as Record<K, string>
  for (const key of Object.keys(messages) as K[]) Object.defineProperty(labels, key, { enumerable: true, get: () => i18n._(messages[key]) })
  return labels
}

const question = (topic: MemoryTopic, asked: MessageDescriptor, hint: MessageDescriptor): { topic: MemoryTopic; question: string; hint: string } => ({
  topic,
  get question() { return i18n._(asked) },
  get hint() { return i18n._(hint) },
})

export const questions: { topic: MemoryTopic; question: string; hint: string }[] = [
  question('communication', msg`How should Sotto keep you in the loop?`, msg`Short or detailed replies, spoken summaries, progress updates, and when to interrupt you.`),
  question('autonomy', msg`How do you like work to get started?`, msg`Planning first, architecture decisions, new dependencies, branches, and worktrees.`),
  question('verification', msg`What makes a change ready for you?`, msg`Tests, visual checks, and the evidence you want before calling work finished.`),
  question('git', msg`How should commits and reviews work?`, msg`Commit timing, pull requests, reviews, and when to ask about merging.`),
  question('agents', msg`Do you prefer particular agents for certain work?`, msg`Name a model and the work it suits, or say you have no preference.`),
  question('workflow', msg`What should Sotto know about your workday?`, msg`Repeated tasks, project conventions, focus time, and habits worth remembering.`),
  question('privacy', msg`What are your preferences for keeping history?`, msg`Importing past conversations, retention, export, and deletion. This answer does not enable imports or change your settings.`),
]

const boundaryMessages = {
  spend: msg`Starting new spending`,
  publish: msg`Publishing or sending work outside Sotto`,
  destroy: msg`Deleting or making irreversible changes`,
  'relax-verification': msg`Skipping or weakening verification`,
} as const

export const boundaryLabels = translated(boundaryMessages)

/** Every action a saved policy can name, including the ones the questionnaire never offers. */
export const policyActionLabels = translated({
  ...boundaryMessages,
  'remote-answer': msg`Answering permissions from a paired client`,
})
