import type { AgentActivity } from '../../src/shared/agentActivity'

/** Inspect native activity in memory; evidence contains only the returned booleans. */
export function watcherNativeReadProof(activities: AgentActivity[], previousIds: Set<string>, filename: string, marker: string): { read: boolean; search: boolean } {
  let read = false, search = false
  for (const activity of activities) {
    if (previousIds.has(activity.id) || !['command', 'tool'].includes(activity.kind) || activity.status !== 'completed' || activity.exitCode !== undefined && activity.exitCode !== 0 || activity.error) continue
    const input = [activity.command, activity.text, ...(activity.changes ?? []).map(change => change.path)].filter(Boolean).join('\n')
    if (!activity.output?.includes(marker)) continue
    const readFile = input.includes(filename), searchFile = readFile || activity.output.includes(filename)
    if (activity.kind === 'command') {
      read ||= readFile && /\b(?:Get-Content|cat|type|sed)\b/iu.test(activity.command ?? '')
      search ||= searchFile && /\b(?:Select-String|rg|grep|findstr)\b/iu.test(activity.command ?? '') && input.includes('native_read_')
    } else {
      read ||= readFile && /^(?:read\b|read_file\b|readfile\b|view_file\b)/iu.test(activity.title)
      search ||= searchFile && (/^(?:grep(?:_search|\b)|search(?:_files|_file_contents|\b)|text_search\b|ripgrep\b)/iu.test(activity.title) || activity.changes?.some(change => change.kind === 'search') === true) && input.includes('native_read_')
    }
  }
  return { read, search }
}
