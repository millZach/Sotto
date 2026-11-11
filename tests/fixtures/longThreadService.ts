import type { HostService } from '../../src/main/agents/hostService'
import type { AgentThreadDetail } from '../../src/shared/agents'

/**
 * A host's service with one long thread to read, `long`, and the rest as `service` has it. The thread's detail is not
 * watched, so a listener reading it sends it once. `more` adds what a test's own service does, such as keeping a photo.
 */
export const serviceWithLongThread = (service: HostService, detail: AgentThreadDetail, more: Partial<HostService> = {}): HostService => ({
  shell: () => service.shell(), state: () => service.state(),
  events: (afterSeq, threadId, limit) => service.events(afterSeq, threadId, limit), subscribe: listener => service.subscribe(listener),
  threadDetail: id => id === 'long' ? structuredClone(detail) : service.threadDetail(id),
  command: (command, identity) => service.command(command, identity),
  subscribeThreadDetail: () => () => undefined,
  ...more,
})

/** What makes a listener a headless host's tailnet listener with no desktop recorded, where every peer is a phone. */
export const PHONES_ONLY_TAILNET = { phonesAdmitted: () => true, desktops: { has: () => false, refresh: async () => undefined } }
