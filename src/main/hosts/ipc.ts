import { z } from 'zod'
import { HOSTS_GET, HOSTS_COMMAND, HOSTS_SSH_SUGGESTIONS, hostsCommandSchema, type HostsState, type SshHostSuggestion } from '../../shared/hosts'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { DesktopHosts } from './desktopHosts'
import { discoverSshHosts } from './sshSuggestions'

export function registerHostsIpc(ipc: IpcMainAdapter, hosts: DesktopHosts, senders: () => readonly TrustedIpcSender[], publish: (state: HostsState) => void,
  suggestions: () => Promise<SshHostSuggestion[]> = () => discoverSshHosts()): () => void {
  ipc.handle(HOSTS_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Hosts in the main Sotto window.')
    z.tuple([]).parse(args)
    return hosts.get()
  })
  ipc.handle(HOSTS_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Hosts in the main Sotto window.')
    const [command] = z.tuple([hostsCommandSchema]).parse(args)
    return hosts.command(command)
  })
  // The SSH configuration and known hosts are read on each request, so an alias added a moment ago is offered.
  ipc.handle(HOSTS_SSH_SUGGESTIONS, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Hosts in the main Sotto window.')
    z.tuple([]).parse(args)
    return suggestions()
  })
  const off = hosts.subscribe(publish)
  return () => { off(); ipc.removeHandler(HOSTS_GET); ipc.removeHandler(HOSTS_COMMAND); ipc.removeHandler(HOSTS_SSH_SUGGESTIONS) }
}
