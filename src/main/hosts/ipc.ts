import { z } from 'zod'
import { HOSTS_GET, HOSTS_COMMAND, hostsCommandSchema, type HostsState } from '../../shared/hosts'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { DesktopHosts } from './desktopHosts'

export function registerHostsIpc(ipc: IpcMainAdapter, hosts: DesktopHosts, senders: () => readonly TrustedIpcSender[], publish: (state: HostsState) => void): () => void {
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
  const off = hosts.subscribe(publish)
  return () => { off(); ipc.removeHandler(HOSTS_GET); ipc.removeHandler(HOSTS_COMMAND) }
}
