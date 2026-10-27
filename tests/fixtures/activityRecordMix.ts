import { randomBytes } from 'node:crypto'
import type { AgentActivity } from '../../src/shared/agentActivity'

const at = '2026-10-22T10:00:00.000Z'

/**
 * A busy thread's activity, for a benchmark that reads stored records back (`storedActivityRead.perf.test.ts`,
 * `storedActivityReadBack.perf.test.ts`): commands with output, file changes with diffs, thinking, plans, tools and the odd
 * subagent, the last as the store keeps it, its classification without the task's words. At `scale` 1 the mix averages
 * about 1 KB of words a record, so 2,000 records at 5 come to about 11 MB. Every word is random.
 */
export function activityRecordMix(scale: number): (index: number) => AgentActivity {
  const words = (size: number): string => { const bytes = Math.round(size * scale); return randomBytes(Math.ceil(bytes * 0.75)).toString('base64').slice(0, bytes) }
  return index => {
    const base = { id: `activity-${index}`, turnId: `turn-${index >> 4}`, sequence: index, afterMessageId: `message-${index >> 4}`,
      startedAt: at, completedAt: at, timingSource: 'observed' as const, durationMs: 1_250 }
    switch (index % 6) {
      case 0: return { ...base, kind: 'command', status: 'completed', title: 'npm test', command: `npm test -- ${words(40)}`, cwd: 'D:/project', output: words(2_000), exitCode: 0 }
      case 1: return { ...base, kind: 'file-change', status: 'completed', title: 'Edited 2 files',
        changes: [{ path: 'src/a.ts', kind: 'update', diff: words(1_500) }, { path: 'src/b.ts', kind: 'update', diff: words(800) }] }
      case 2: return { ...base, kind: 'reasoning', status: 'completed', title: 'Thinking', text: words(1_000) }
      case 3: return { ...base, kind: 'plan', status: 'completed', title: 'Plan',
        steps: Array.from({ length: 6 }, (_, step) => ({ text: words(80), status: step < 3 ? 'completed' as const : 'pending' as const })) }
      case 4: return { ...base, kind: 'subagent', status: 'completed', title: 'Subagent',
        agents: [{ id: `agent-${index}`, status: 'completed', assignmentId: `assignment-${index}`, model: 'model', startedAt: at, completedAt: at }] }
      default: return { ...base, kind: 'tool', status: 'completed', title: 'Read file', output: words(600) }
    }
  }
}
