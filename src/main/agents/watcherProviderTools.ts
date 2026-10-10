import type { AgentHostCommand } from './host'
import type { AgentRequest } from '../../shared/agents'
import { WatcherProfileRefusal } from './watcherProfile'
import type { ScopedThreadTools } from './threadToolServer'

/** The browser's standing grant and host setup are outside the center's asking policy. */
export function watcherThreadTools(tools: readonly ScopedThreadTools[]): readonly ScopedThreadTools[] {
  return tools.filter(tool => tool.name === 'sotto_visual' || tool.name === 'sotto_pull_requests')
}

/** A one-time native approval leaves the pinned mode intact; remembered grants do not. */
export function assertWatcherPermissionChoice(request: AgentRequest, choice?: string): void {
  const selected = request.permissionChoices?.find(value => value.id === choice)
  if (selected?.kind === 'allow-session' || selected?.kind === 'allow-always') {
    throw new WatcherProfileRefusal('Watcher’s permission mode cannot be widened. Allow this request once, or deny it.')
  }
}

export function assertWatcherPermission(command: AgentHostCommand): void {
  if ((command.type === 'configure-thread' || command.type === 'create-thread')
    && (command.runtimeMode !== undefined && command.runtimeMode !== 'approval-required' || command.providerMode !== undefined)) {
    throw new WatcherProfileRefusal('Watcher always asks before edits, writing commands and network use. Its permission mode cannot be widened. Choose only its model and effort.')
  }
}
