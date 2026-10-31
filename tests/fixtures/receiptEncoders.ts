import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'

/**
 * The two receipt encoders `registerAgentIpc` takes, from one broadcaster as `src/main/index.ts` hands them: a reply asked
 * for as changed thread records is measured from what that broadcaster last sent the window.
 */
export function receiptEncoders(broadcaster = new AgentStateBroadcaster()): Pick<AgentStateBroadcaster, 'encodeReceipt' | 'encodeChangedThreadRecordsReceipt'> {
  return { encodeReceipt: broadcaster.encodeReceipt, encodeChangedThreadRecordsReceipt: broadcaster.encodeChangedThreadRecordsReceipt }
}
