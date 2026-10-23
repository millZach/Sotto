import type { OpenCodeHost } from '../agents/opencode'
import type { OwnServersOpenCode } from './service'

/**
 * Sotto's OpenCode as the user's own model servers reach it (ADR-0123). A key goes through OpenCode's existing key
 * sign-in (#1104, its `KEY_METHOD`), with the server's ID as the source, so OpenCode keeps it as it keeps every model
 * source's key, and Remove deletes it the way Sign out does.
 */
export function openCodeForOwnServers(host: Pick<OpenCodeHost, 'isConnected' | 'ownServersChanged' | 'signIn'>): OwnServersOpenCode {
  return {
    running: () => host.isConnected(),
    outdated: () => host.ownServersChanged(),
    catalogAgain: () => host.signIn.catalogAgain(),
    signInWithKey: async (sourceId, key) => (await host.signIn.signInWithKey({ sourceId, key })).status === 'ok',
    signOut: async sourceId => (await host.signIn.signOut({ sourceId })).status === 'ok',
  }
}
