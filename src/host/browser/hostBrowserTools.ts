import type { BrowserEvent } from '../../shared/browser'
import type { BrowserAgentServer } from '../../main/agents/browserAgentServer'
import { FilesService, type FilesBinding } from '../../main/files/service'
import { createHostBrowserAgentServer } from '../../main/tools/browserAgentTools'
import { HostBrowser } from './hostBrowser'
import { HostBrowserService } from './hostBrowserService'

export interface HostBrowserToolsOptions {
  /** The host's own threads' working copies, through the resolver its Files and Changes reads use. */
  resolveBinding(threadId: string): FilesBinding | null
  readonly withoutAsking: boolean
  saveWithoutAsking(value: boolean): Promise<void>
  readonly browser?: HostBrowser
}
export interface HostBrowserTools {
  readonly service: HostBrowserService
  /** `sotto-browser` for this host's own threads, with the six browser tools. */
  readonly tools: BrowserAgentServer
  /** Hears the host's pages, tasks and grants change, for the desktops that show them. Returns the way to stop. */
  subscribe(listener: (event: BrowserEvent) => void): () => void
  close(): Promise<void>
}

/** A browser serves no copy and reveals nothing on the host; those act on the machine the window is on. */
const notHere = (): never => { throw new Error('The browser does not copy or open anything on the host.') }

/** Sotto's browser for this host's own threads (ADR-0198): the service over the host's Chromium, and its tool server. */
export function hostBrowserTools(options: HostBrowserToolsOptions): HostBrowserTools {
  const files = new FilesService({ resolveBinding: options.resolveBinding, copyPath: notHere, reveal: notHere })
  const listeners = new Set<(event: BrowserEvent) => void>()
  const service = new HostBrowserService({ browser: options.browser ?? new HostBrowser(), files, withoutAsking: options.withoutAsking, saveWithoutAsking: options.saveWithoutAsking,
    emit: event => { for (const listener of [...listeners]) { try { listener(event) } catch { /* A listener's failure is its own. */ } } } })
  const tools = createHostBrowserAgentServer(service)
  return { service, tools,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    close: async () => { listeners.clear(); await tools.close(); await service.shutDown() } }
}
