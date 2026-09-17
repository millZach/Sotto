import type { ProviderCommandOptions } from './options'

/** Grok CLI flags, checked against `grok --help` on 2026-09-16. Sotto makes the worktree itself, so `--worktree` is never passed. */
export function grokCommand({ model, reasoning, permission }: ProviderCommandOptions): string[] {
  const argv = ['grok']
  if (model) argv.push('-m', model)
  if (reasoning) argv.push('--reasoning-effort', reasoning)
  if (permission === 'ask') argv.push('--permission-mode', 'default')
  else if (permission === 'edits') argv.push('--permission-mode', 'acceptEdits')
  else if (permission === 'everything') argv.push('--permission-mode', 'bypassPermissions')
  return argv
}
