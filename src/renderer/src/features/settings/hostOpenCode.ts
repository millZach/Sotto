import type { OpenCodeSignInBridge } from '../../../../shared/opencodeSignIn'
import type { HostsBridge } from '../../../../shared/hosts'

/**
 * The Add a model source dialog's bridge for a connected host's own OpenCode (#1107): each call goes through this
 * computer's main to that host alone, which answers as the desktop's own sign-in does. Undefined while OpenCode's Owl
 * feature is off, when the hosts bridge has no such call.
 */
export function hostOpenCodeBridge(hosts: HostsBridge, id: string): OpenCodeSignInBridge | undefined {
  const call = hosts.opencodeSignIn?.bind(hosts)
  if (!call) return undefined
  return {
    sources: () => call({ id, call: { action: 'sources' } }),
    signInWithKey: request => call({ id, call: { action: 'key', request } }),
    startBrowserSignIn: request => call({ id, call: { action: 'browser', request } }),
    useExternalSignIn: request => call({ id, call: { action: 'external', request } }),
    wait: request => call({ id, call: { action: 'wait', request } }),
    finish: request => call({ id, call: { action: 'finish', request } }),
    reopen: request => call({ id, call: { action: 'reopen', request } }),
    cancel: request => call({ id, call: { action: 'cancel', request } }),
    signOut: request => call({ id, call: { action: 'sign-out', request } }),
  }
}
