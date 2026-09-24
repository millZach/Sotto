import { z } from 'zod'

export const HOSTS_GET = 'hosts:get'
export const HOSTS_COMMAND = 'hosts:command'
export const HOSTS_CHANGED = 'hosts:changed'
export const HOSTS_SSH_SUGGESTIONS = 'hosts:ssh-suggestions'

/** Where a new host's installation and data folders default to on the SSH host. */
export const DEFAULT_HOST_INSTALL_PATH = '~/.local/share/sotto-host'
export const DEFAULT_HOST_DATA_DIRECTORY = '~/.sotto'

export const remoteHostSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80),
  target: z.string().trim().min(1).max(256), identityFile: z.string().max(4096).default(''),
  installPath: z.string().min(1).max(4096), dataDirectory: z.string().min(1).max(4096),
  /** The SSH port when it is not the one the SSH configuration gives; passed to ssh as `-p`. */
  sshPort: z.number().int().min(1).max(65535).optional(),
  /**
   * Whether the host is switched on: kept connected now and at every launch. Absent on hosts saved before
   * the switch existed, which count as on.
   */
  enabled: z.boolean().optional(),
}).strict()
export type RemoteHost = z.infer<typeof remoteHostSchema>
export interface HostStatus extends Omit<RemoteHost, 'enabled'> {
  enabled: boolean
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
export interface HostsState {
  hosts: HostStatus[]; localHostEnabled: boolean; localHostRunning: boolean; activeHostId?: string; localHostId?: string
  /** The host the Add host dialog is connecting to. It is saved, and joins `hosts`, only once it answers and pairs. */
  adding?: HostStatus
}
export const hostsCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), host: remoteHostSchema.omit({ enabled: true }) }).strict(),
  z.object({ type: z.literal('cancel-add'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('save'), host: remoteHostSchema.omit({ enabled: true }) }).strict(),
  z.object({ type: z.literal('rename'), id: z.uuid(), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ type: z.literal('set-enabled'), id: z.uuid(), enabled: z.boolean() }).strict(),
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
