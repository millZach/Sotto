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
  /** What a connected desktop hears of pages, tasks and grants; nothing listens until the protocol carries them. */
  emit?(event: BrowserEvent): void
  readonly browser?: HostBrowser
}
export interface HostBrowserTools {
  readonly service: HostBrowserService
  /** `sotto-browser` for this host's own threads, with the six browser tools. */
  readonly tools: BrowserAgentServer
  close(): Promise<void>
}

/** A browser serves no copy and reveals nothing on the host; those act on the machine the window is on. */
const notHere = (): never => { throw new Error('The browser does not copy or open anything on the host.') }

/** Sotto's browser for this host's own threads (ADR-0198): the service over the host's Chromium, and its tool server. */
export function hostBrowserTools(options: HostBrowserToolsOptions): HostBrowserTools {
  const files = new FilesService({ resolveBinding: options.resolveBinding, copyPath: notHere, reveal: notHere })
  const service = new HostBrowserService({ browser: options.browser ?? new HostBrowser(), files, emit: event => options.emit?.(event),
    withoutAsking: options.withoutAsking, saveWithoutAsking: options.saveWithoutAsking })
  const tools = createHostBrowserAgentServer(service)
  return { service, tools, close: async () => { await tools.close(); await service.shutDown() } }
}
