import type { ProviderCommandOptions } from './options'

/** Claude Code flags, checked against `claude --help` on 2026-09-16. Asking for approval is its default. */
export function claudeCommand({ model, reasoning, permission }: ProviderCommandOptions): string[] {
  const argv = ['claude']
  if (model) argv.push('--model', model)
  if (reasoning) argv.push('--effort', reasoning)
  if (permission === 'edits') argv.push('--permission-mode', 'acceptEdits')
  else if (permission === 'everything') argv.push('--dangerously-skip-permissions')
  return argv
}
