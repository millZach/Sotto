import type { AgentHostCommand } from './host'
import type { AgentRequest } from '../../shared/agents'
import type { ScopedThreadTools } from './threadToolServer'

/** The browser's standing grant and host setup remain outside Watcher's scoped tools. */
export function watcherThreadTools(tools: readonly ScopedThreadTools[]): readonly ScopedThreadTools[] {
  return tools.filter(tool => tool.name === 'sotto_visual' || tool.name === 'sotto_pull_requests')
}

/** The user's runtime mode is separate from a native remembered permission grant. */
export function assertWatcherPermissionChoice(request: AgentRequest, choice?: string): void {
  const selected = request.permissionChoices?.find(value => value.id === choice)
  if (selected?.kind === 'allow-session' || selected?.kind === 'allow-always') {
    throw new Error('Watcher cannot remember this permission grant. Allow this request once, or deny it.')
  }
}

export function assertWatcherPermission(command: AgentHostCommand): void {
  if ((command.type === 'configure-thread' || command.type === 'create-thread')
    && command.providerMode !== undefined) {
    throw new Error('Choose one of Watcher’s ordinary permission modes.')
  }
}
