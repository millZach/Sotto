import type { ProviderCommandOptions } from './options'

/** Codex CLI flags, checked against `codex --help` on 2026-09-16. Reasoning goes through a config override. */
export function codexCommand({ model, reasoning, permission }: ProviderCommandOptions): string[] {
  const argv = ['codex']
  if (model) argv.push('-m', model)
  if (reasoning) argv.push('-c', `model_reasoning_effort=${reasoning}`)
  if (permission === 'ask') argv.push('-a', 'on-request', '-s', 'workspace-write')
  else if (permission === 'edits') argv.push('--full-auto')
  else if (permission === 'everything') argv.push('--dangerously-bypass-approvals-and-sandbox')
  return argv
}
