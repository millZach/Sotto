/** ACP explicitly identifies a search even when its display title or output omits matching lines. */
export function commandCenterGrokSearchProof(updates: Record<string, unknown>[], filename: string, pattern: string): boolean {
  const lastPrompt = updates.findLastIndex(update => update.sessionUpdate === 'user_message_chunk')
  if (lastPrompt < 0) return false
  const rows = new Map<string, Record<string, unknown>>()
  for (const update of updates.slice(lastPrompt + 1)) {
    if (typeof update.toolCallId !== 'string' || !['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate))) continue
    rows.set(update.toolCallId, { ...rows.get(update.toolCallId), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) })
  }
  return [...rows.values()].some(row => {
    const input = JSON.stringify(row.rawInput)
    const output = row.rawOutput !== null && typeof row.rawOutput === 'object' ? row.rawOutput as Record<string, unknown> : undefined
    const exitCode = output?.exitCode ?? output?.exit_code
    return row.kind === 'search' && row.status === 'completed' && !row.error && output?.isError !== true && output?.is_error !== true
      && (exitCode === undefined || exitCode === 0) && input?.includes(filename) === true && input.includes(pattern)
  })
}
