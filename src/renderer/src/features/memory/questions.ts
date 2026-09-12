import type { MemoryTopic } from '../../../../shared/memory'

export const questions: { topic: MemoryTopic; question: string; hint: string }[] = [
  { topic: 'communication', question: 'How should Sotto keep you in the loop?', hint: 'Short or detailed replies, spoken summaries, progress updates, and when to interrupt you.' },
  { topic: 'autonomy', question: 'How do you like work to get started?', hint: 'Planning first, architecture decisions, new dependencies, branches, and worktrees.' },
  { topic: 'verification', question: 'What makes a change ready for you?', hint: 'Tests, visual checks, and the evidence you want before calling work finished.' },
  { topic: 'git', question: 'How should commits and reviews work?', hint: 'Commit timing, pull requests, reviews, and when to ask about merging.' },
  { topic: 'agents', question: 'Do you prefer particular agents for certain work?', hint: 'Name a model and the work it suits, or say you have no preference.' },
  { topic: 'workflow', question: 'What should Sotto know about your workday?', hint: 'Repeated tasks, project conventions, focus time, and habits worth remembering.' },
  { topic: 'privacy', question: 'What are your preferences for keeping history?', hint: 'Importing past conversations, retention, export, and deletion. This answer does not enable imports or change your settings.' },
]

export const boundaryLabels = {
  spend: 'Starting new spending',
  publish: 'Publishing or sending work outside Sotto',
  destroy: 'Deleting or making irreversible changes',
  'relax-verification': 'Skipping or weakening verification',
} as const
