import { z } from 'zod'

export const HOSTS_GET = 'hosts:get'
export const HOSTS_COMMAND = 'hosts:command'
export const HOSTS_CHANGED = 'hosts:changed'
export const HOSTS_SSH_SUGGESTIONS = 'hosts:ssh-suggestions'

export const remoteHostSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80),
  target: z.string().trim().min(1).max(256), identityFile: z.string().max(4096).default(''),
  installPath: z.string().min(1).max(4096), dataDirectory: z.string().min(1).max(4096),
}).strict()
export type RemoteHost = z.infer<typeof remoteHostSchema>
export interface HostStatus extends RemoteHost {
  phase: 'disconnected' | 'connecting' | 'connected' | 'error'
  reconnecting?: boolean | undefined
  hostId?: string
  clientId?: string
  /**
   * True while connected to a host this Sotto started, or while the SSH session to one running another
   * Sotto version stays open for Stop host; only such a host answers Stop host.
   */
  owned?: boolean | undefined
  error?: string | undefined
  prompt?: { id: string; kind: 'host-key' | 'password' | 'passphrase'; text: string }
}
export interface HostsState { hosts: HostStatus[]; localHostEnabled: boolean; localHostRunning: boolean; activeHostId?: string; localHostId?: string }
export const hostsCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('save'), host: remoteHostSchema }).strict(),
  z.object({ type: z.literal('connect'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('disconnect'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('stop-host'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('forget'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('ssh-answer'), id: z.uuid(), promptId: z.string().max(256), answer: z.string().max(4096) }).strict(),
  z.object({ type: z.literal('restart') }).strict(),
  z.object({ type: z.literal('select'), hostId: z.uuid() }).strict(),
])
export type HostsCommand = z.infer<typeof hostsCommandSchema>

/**
 * A host the user's own SSH setup already knows, offered while typing in Add host: an alias from the SSH
 * configuration, or a name from known hosts. Read on this computer and never sent anywhere.
 */
export interface SshHostSuggestion {
  readonly alias: string
  /** Where the alias goes, such as `zach@forge.example.net`, when the configuration says. */
  readonly detail?: string
  /** A known host recorded on a port other than 22. */
  readonly port?: number
  readonly source: 'config' | 'known-hosts'
}
export interface HostsBridge {
  get(): Promise<HostsState>
  command(command: HostsCommand): Promise<HostsState>
  onChanged(listener: (state: HostsState) => void): () => void
  /** The hosts this computer's SSH configuration and known hosts name, read when asked. */
  sshSuggestions(): Promise<SshHostSuggestion[]>
}

/** Client projection only; remote wire payloads keep their original host-local IDs. */
export interface HostConnectionSummary { hostId: string; name: string; kind: 'local' | 'remote'; connected: boolean }
