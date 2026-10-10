import { COMMAND_CENTER_GROUPS } from '../../src/shared/commandCenterOverview'
import { emptyCommandCenterRecord, type CommandCenterRecord, type CommandCenterToolName } from '../../src/shared/commandCenter'

export const centerHostId = '11111111-1111-4111-8111-111111111111'
export const centerRequestId = '22222222-2222-4222-8222-222222222222'
export const centerRetryKey = '33333333-3333-4333-8333-333333333333'
export const centerOperationId = '44444444-4444-4444-8444-444444444444'
export const centerTime = '2026-10-09T10:00:00.000Z'
export const centerTarget = { hostId: centerHostId, threadId: 'worker' }
export const centerProject = { hostId: centerHostId, projectId: 'project' }
const mutation = { requestId: centerRequestId, retryKey: centerRetryKey }
const receipt = { operationId: centerOperationId, target: centerTarget, requestId: centerRequestId,
  deliveryState: 'accepted', receiptId: 'receipt', cardId: 'card', messageId: 'message' }
const limits = { inFlight: 1, inFlightLimit: 4, promptCount: 1, promptLimit: 4 }
const state = { status: 'idle', stopped: true, settled: true, backgroundWorkCount: 0, observedAt: centerTime, freshness: 'fresh' }
const page = { nextCursor: null, observedAt: centerTime, staleHosts: [] }
const permission = { kind: 'runtime', mode: 'approval-required' }
const workingCopy = { kind: 'shared' }

/** Concrete, non-authoritative examples for consumers developing before the runtime tickets. */
export const commandCenterToolFixtures: Record<CommandCenterToolName, { input: unknown; output: unknown }> = {
  list_threads: { input: {}, output: { status: 'ok', rows: [{ target: centerTarget, title: 'Worker', projectId: 'project', provider: 'codex', modelId: 'model',
    status: 'idle', group: 'Idle', waitsOn: [{ id: 'question', kind: 'question', label: 'Choose a scope', openTarget: centerTarget }],
    branch: null, workingCopy, pullRequests: [], evidence: [], lastActivityAt: centerTime, observedAt: centerTime, connected: true, freshness: 'fresh',
    userReadAt: null, commandCenterReadAt: null, participation: [], protected: false }],
    snapshotRevision: 'snapshot-1', counts: Object.fromEntries(COMMAND_CENTER_GROUPS.map(group => [group, group === 'Idle' ? 1 : 0])), ...page } },
  read_thread: { input: { target: centerTarget }, output: { status: 'ok', target: centerTarget,
    messages: [{ id: 'message', position: 1, role: 'assistant', text: 'Done', createdAt: centerTime }], waitsOn: [], activities: [], evidence: [],
    historyEpoch: 'epoch-0', firstPosition: 1, lastPosition: 1, nextPosition: 1, truncated: false, earlierAvailable: false, observedAt: centerTime } },
  start_thread: { input: { ...mutation, project: centerProject, modelId: 'model', reasoningEffort: 'high', workingCopy, title: 'Worker', firstPrompt: 'Inspect the project' },
    output: { status: 'ok', receipt, limits, target: centerTarget, effectiveChoices: { modelId: 'model', reasoningEffort: 'high', permission, workingCopy },
      creationReceiptId: 'creation', firstPromptReceiptId: 'first-prompt' } },
  send_to_thread: { input: { ...mutation, target: centerTarget, text: 'Continue the inspection', delivery: 'now' }, output: { status: 'ok', receipt, limits, delivery: 'now' } },
  stop_thread: { input: { ...mutation, target: centerTarget }, output: { status: 'ok', receipt, limits, stopRequested: true, state } },
  settle_thread: { input: { ...mutation, target: centerTarget }, output: { status: 'ok', receipt, limits, state } },
  list_projects: { input: {}, output: { status: 'ok', projects: [{ target: centerProject, title: 'Project', displayRoot: 'D:/Project',
    workers: [{ provider: 'devin', modelId: 'model', reasoningEfforts: [], defaultPermission: null, permissionComparable: false }],
    controlAvailable: false, readsAvailable: true, readOnlyProfileAvailable: false, freshness: 'fresh' }], ...page } },
  list_working_copies: { input: { project: centerProject }, output: { status: 'ok', project: centerProject, revision: 'choices-1',
    choices: [{ choiceId: 'shared-1', kind: 'shared', branch: 'main', occupied: false, locked: false, limitations: [] }], baseRefs: [{ choiceId: 'base-1', name: 'main' }], ...page } },
  read_operation: { input: { operationId: centerOperationId }, output: { status: 'ok', receipt, limits, action: 'send', state } },
}

export function commandCenterRecordFixture(): CommandCenterRecord {
  const record = emptyCommandCenterRecord()
  record.current = { target: { hostId: centerHostId, threadId: 'center' }, projectId: 'center-project', provider: 'codex',
    creationOperationId: centerOperationId, createdAt: centerTime }
  record.requests = [{ id: centerRequestId, commandCenter: record.current.target, rootUserMessageId: 'root-message', state: 'active', createdAt: centerTime,
    closedAt: null, participants: [{ target: centerTarget, requestId: centerRequestId, startedBy: 'command-center', generation: 0, state: 'participating', promptCount: 1 }] }]
  record.operations = [{ id: centerOperationId, requestId: centerRequestId, retryKey: centerRetryKey, digest: 'a'.repeat(64), action: 'send', target: centerTarget,
    generation: 0, delivery: 'now', deliveryState: 'uncertain', createdAt: centerTime, updatedAt: centerTime, receiptId: 'receipt', cardId: 'card', messageId: 'message' }]
  record.reservations = [{ target: centerTarget, requestId: centerRequestId, operationId: centerOperationId, generation: 0, reason: 'uncertain' }]
  record.reads = [{ target: centerTarget, position: { historyEpoch: 'epoch-0', afterPosition: 1 }, readAt: centerTime }]
  return record
}
