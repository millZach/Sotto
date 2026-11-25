// @vitest-environment node
// Node -> Rust -> Node for every store other than the thread stores that both a Rust host and Node write (ADR-0214):
// Councils, checkpoints, plugins, pairing, phone access and Watcher. Each store as Node writes it is checked with
// Node's own parser, loaded and saved by the Rust host's own code, and read again here, which must change nothing Node
// reads. Each store a Rust host creates records in is also read here, which Node must accept. Each store gets its own
// folder and its own Rust test. Runs when `SOTTO_TEST_RUST_HOST=1` (the Rust host CI job, and locally after a
// `cargo build`).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFollowupStore } from '../../src/main/agents/followups'
import { parseLimitRestartFile } from '../../src/main/agents/limitRestart'
import { parsePairedClientsFile } from '../../src/main/agents/pairing'
import { parseWatcherQuestionsFile } from '../../src/main/agents/watcherQuestions'
import { parseWatcherRecordFile } from '../../src/main/agents/watcherRecords'
import { readKeptRecord } from '../../src/main/agents/watcherState'
import { parseWatcherToldFile } from '../../src/main/agents/watcherToldNews'
import { councilFileSchema } from '../../src/main/council/councilRecord'
import { parseLocalAppsFile } from '../../src/main/phones/localApps'
import { parsePhoneAccessRecord, parsePhoneClients } from '../../src/main/phones/phoneAccess'
import { parsePluginAccounts } from '../../src/main/plugins/accounts'
import { parsePluginCopyChoices } from '../../src/main/plugins/copySync'
import { parseMailGrants } from '../../src/main/plugins/mailGrants'
import { parseHeardSpending } from '../../src/main/plugins/spending'
import { parsePluginUses } from '../../src/main/plugins/useRecord'
import { parseCheckpointStorage } from '../../src/main/tools/checkpointStore'
import { parseSoundRecords } from '../../src/main/tools/elevenlabs/records'
import { parseModelRecords } from '../../src/main/tools/meshy/records'
import { KEEP_WATCHING, SETTLE_IT } from '../../src/shared/watcherQuestions'
import { runRustStoreTest } from './rustHostNodeStores'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const TIME = '2026-11-20T10:00:00.000Z', DIGEST = '0000000000000000000000000000000000000000000000000000000000000abc'

// Councils
const seat = (seat: string, role: string, thread: string) => ({ seat, role, modelId: 'model-1', modelName: 'Model One', provider: 'claude',
  effort: 'high', thread, formerThreads: ['former-1'], started: true, context: true })
const frozen = (id: string) => ({ kind: 'frozen', id, sourceKind: 'git', manifestHash: 'a'.repeat(64), files: 2, bytes: 10,
  retained: true, capturedAt: TIME, removedAt: '2026-11-21T10:00:00.000Z' })
const snapshot = { path: '/snapshots/1', repositoryRoot: '/home/zach/work', commit: 'abc123', branch: 'main', untracked: 1, dirty: true, removedAt: '2026-11-21T10:00:00.000Z' }
const BASELINE = '11111111-1111-4111-8111-111111111111', CANDIDATE = '22222222-2222-4222-8222-222222222222'
const councils = { version: 2, councils: [
  { id: '00000000-0000-4000-8000-000000000001', createdAt: TIME, originThread: 'thread-origin', originTitle: 'Origin thread', projectId: 'project-1', snapshot,
    history: { messages: 4, words: 120, tools: 1, parts: 2, lastMessageId: 'msg-4' },
    seats: [seat('A', 'panelist', 't-a'), seat('B', 'panelist', 't-b'),
      { seat: 'chair', role: 'chair', modelId: 'model-2', modelName: 'Model Two', effort: null, thread: 't-c', formerThreads: [], started: false, context: false }],
    rounds: [{ index: 0, askedAt: TIME, stage: 'done', leftOut: ['B'], reviewPlan: { A: ['B'] }, framingFallback: false, kinds: ['decision', 'fact'], research: true,
      reframedAt: '2026-11-20T10:01:00.000Z', criteria: [{ id: 'c1', source: 'user', text: 'Fast' }], cruxRunners: ['A'], cruxDone: true,
      fairnessAt: '2026-11-20T10:05:00.000Z', doneAt: '2026-11-20T10:06:00.000Z',
      objections: [{ seat: 'A', claim: 'Too slow', passage: 'It runs twice', answer: 'amended', reason: 'Fixed', turn: '33333333-3333-4333-8333-333333333333' }],
      question: 'Should we migrate?',
      framing: { kinds: ['decision'], criteria: [{ id: 'c1', source: 'question', text: 'Fast' }], headings: ['Answer'], words: 300,
        angles: [{ seat: 'A', text: 'Cost' }], research: { needed: true, reason: 'Docs' } },
      crux: { test: 'Run it', lookup: false, sides: [['A'], ['B']], meanings: [{ result: 'fast', meaning: 'A wins' }, { result: 'slow', meaning: 'B wins' }] },
      verdict: 'Migrate.', amended: true,
      evidence: { source: 'legacy-git', baseline: BASELINE, candidate: CANDIDATE, incumbent: BASELINE, reference: CANDIDATE } }],
    turns: [{ id: '33333333-3333-4333-8333-333333333333', round: 0, seat: 'chair', thread: 't-c', stage: 'amend',
      repairOf: '44444444-4444-4444-8444-444444444444', establish: 1, part: 1, objections: ['A'],
      draftId: '55555555-5555-4555-8555-555555555555', messageId: '66666666-6666-4666-8666-666666666666',
      delivery: 'accepted', outcome: 'answered', queuedAt: '2026-11-20T10:02:00.000Z', sentAt: '2026-11-20T10:02:01.000Z',
      briefs: true, replyMessageId: 'reply-1', result: 'valid', superseded: false,
      block: { answers: [{ objection: 'A', answer: 'amended' }], nodeOnlyField: 'kept' },
      summary: 'Amended', reason: 'Fixed', citations: [{ finding: 'A1', path: 'src/a.ts', lines: '1-2', check: 'matches', of: 'source' }] }],
    deadlineMinutes: 10, stoppedAt: '2026-11-20T10:07:00.000Z', stoppedBecause: 'user', settledAt: '2026-11-20T10:08:00.000Z', mode: 'standard',
    askedBy: { provider: 'claude', userMessageId: 'user-1', words: 'Ask the Council',
      delivery: { draftId: '77777777-7777-4777-8777-777777777777', messageId: '88888888-8888-4888-8888-888888888888', state: 'sent' } },
    evidence: [frozen(BASELINE), frozen(CANDIDATE), { kind: 'legacyGit', id: 'legacy-git', snapshot }, { kind: 'legacyLive', id: 'legacy-live' }] },
  { mode: 'climb', id: '99999999-9999-4999-8999-999999999999', createdAt: '2026-11-20T11:00:00.000Z', originThread: 'thread-origin', originTitle: 'Origin thread',
    projectId: 'project-1', phase: 'setup', evidence: [], rounds: [], turns: [], noImprovement: 0, completedTurns: 0, originLastUser: null, retained: true },
] }

// Checkpoints. No `generation`: every save writes a new one, so only the records are compared.
const files = (hash: string) => ({ files: { 'app.txt': { hash: hash.repeat(64), mode: 33188 }, 'src/main.ts': { hash: 'b'.repeat(64), mode: 33261 } }, index: 'index-tree', head: 'head-commit' })
const checkpoints = { version: 2, records: [
  { id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', threadId: 'thread-1', workspaceId: 'c'.repeat(64), cwd: '/home/zach/work', checkout: '/home/zach/work',
    providerId: 'codex', bindingId: 'codex:session-1', createdAt: TIME, beforeUsers: ['u1'], afterUsers: ['u1', 'u2'], before: files('a'), after: files('d'), status: 'ready' },
  { id: '7a2b3c4d-5e6f-4a7b-9c8d-112233445566', threadId: 'thread-2', workspaceId: 'c'.repeat(64), cwd: '/home/zach/work', providerId: 'claude',
    bindingId: 'claude:session-2', createdAt: '2026-11-20T11:00:00.000Z', beforeUsers: [], before: { files: {}, index: '', head: '' },
    status: 'unavailable', reason: 'Another thread shares this checkout.', unavailableReason: 'shared-checkout' },
] }

// Plugins. Costs and seconds are fractional because Rust writes a whole-number f64 back as `1.0`, which Node reads the same.
const ACCOUNT = '0f8c1d2e-3b4a-4c5d-8e6f-001122334455', MAIL = '1a9d2e3f-4c5b-4d6e-9f70-112233445566', PROTON = '2b0e3f40-5d6c-4e7f-a081-223344556677'
const MESHY = '3c1f4051-6e7d-4f80-b192-334455667788', SOUNDS = '4d205162-7f8e-4091-82a3-445566778899', SESSION = '5e316273-809f-41a2-93b4-5566778899aa', USE = '6f427384-91a0-42b3-a4c5-66778899aabb'
const heard = { version: 1, heard: {
  'host-a': { [MESHY]: { month: '2026-11', credits: 60, heardAt: TIME, session: SESSION, revision: 2 } },
  'host-a#earlier': { [MESHY]: { month: '2026-10', credits: 40, heardAt: '2026-10-30T10:00:00.000Z' } },
} }

// Watcher
const HOST = '0b6f1c2d-3e4b-4a5c-8d6e-7f8091a2b3c4', MASTER_HOST = '1c7a2d3e-4f5b-4b6c-9d7e-8091a2b3c4d5'
const REQUEST = '2d8b3e4f-5a6c-4c7d-8e8f-91a2b3c4d5e6', OPERATION = '3e9c4f5a-6b7d-4d8e-9f9a-a2b3c4d5e6f7'
const target = (threadId: string) => ({ hostId: HOST, threadId })
const identity = (threadId: string, creationOperationId: string) => ({ target: target(threadId), projectId: 'project-1', provider: 'claude', creationOperationId, createdAt: TIME })
const origin = { clientId: 'client-1', masterHostId: MASTER_HOST, masterCreationOperationId: '4fad5a6b-7c8e-4e9f-8a0b-b3c4d5e6f708', masterCreatedAt: TIME }
const event = (id: string, kind: string) => ({ id, kind, requestId: REQUEST, target: target('t-1'), generation: 1, observedAt: TIME })
const readKept = (value: unknown) => readKeptRecord(value, TIME)

/** Each store as Node writes it, with the Rust test that loads and saves it. */
const STORES: readonly { file: string; rust: string; parse: (value: unknown) => unknown; store: unknown }[] = [
  { file: 'councils.json', rust: 'council::tests::node_councils_survives_a_rust_load_and_save', parse: value => councilFileSchema.parse(value), store: councils },
  { file: 'checkpoints/checkpoints.json', rust: 'checkpoints::tests::node_checkpoints_survives_a_rust_load_and_save', parse: value => parseCheckpointStorage(value).records, store: checkpoints },
  { file: 'plugin-accounts.json', rust: 'plugins::tests::node_plugin_accounts_survives_a_rust_load_and_save', parse: parsePluginAccounts, store: { version: 6, accounts: [
    { id: ACCOUNT, plugin: 'vercel', name: 'Personal', savedAt: TIME, signedInAs: 'zach', on: false, projects: ['project-1'] },
    { id: MAIL, plugin: 'gmail', name: 'Work mail', savedAt: '2026-11-20T10:01:00.000Z', signedInAs: null, address: 'zach@example.com' },
    { id: PROTON, plugin: 'proton-mail', name: 'Proton', savedAt: '2026-11-20T10:02:00.000Z', signedInAs: null, address: 'zach@proton.me', bridge: { imapPort: 1143, smtpPort: 1025, certificate: 'ab'.repeat(32) } },
    { id: MESHY, plugin: 'meshy', name: 'Meshy', savedAt: '2026-11-20T10:03:00.000Z', signedInAs: null, spending: { askBefore: false, monthlyLimit: 500 } },
    { id: SOUNDS, plugin: 'elevenlabs', name: 'Studio', savedAt: '2026-11-20T10:04:00.000Z', signedInAs: 'studio', spending: { askBefore: true, monthlyLimit: 10 } },
  ] } },
  { file: 'plugin-use.json', rust: 'plugins::tests::node_plugin_use_survives_a_rust_load_and_save', parse: parsePluginUses, store: { version: 1, uses: [
    { id: USE, at: TIME, threadId: 'thread-1', plugin: 'gmail', accountId: MAIL, tool: 'plugin_read', kind: 'mail-search', outcome: 'done' },
    { id: SESSION, at: '2026-11-20T09:00:00.000Z', threadId: 'thread-2', plugin: 'github', tool: 'github_comment', kind: 'comment', outcome: 'denied' },
  ] } },
  { file: 'plugin-mail-grants.json', rust: 'plugins::tests::node_plugin_mail_grants_survives_a_rust_load_and_save', parse: parseMailGrants, store: { version: 1, grants: [
    { threadId: 'thread-1', accountId: MAIL, at: TIME },
    { threadId: 'host-1:thread-2', accountId: PROTON, at: '2026-11-20T11:00:00.000Z' },
  ] } },
  { file: 'plugin-account-copy-choices.json', rust: 'plugins::tests::node_plugin_account_copy_choices_survives_a_rust_load_and_save', parse: parsePluginCopyChoices,
    store: { version: 1, copyNew: false, choices: { [ACCOUNT]: { 'computer-1': true, 'computer-2': false }, [MESHY]: { 'computer-1': false } } } },
  { file: 'plugin-meshy-spending.json', rust: 'plugins::tests::node_plugin_meshy_spending_survives_a_rust_load_and_save', parse: parseHeardSpending, store: heard },
  { file: 'plugin-elevenlabs-spending.json', rust: 'plugins::tests::node_plugin_elevenlabs_spending_survives_a_rust_load_and_save', parse: parseHeardSpending, store: heard },
  { file: '3d-models.json', rust: 'plugins::tests::node_3d_models_survives_a_rust_load_and_save', parse: parseModelRecords, store: { version: 1, models: [
    { id: 'model-1', threadId: 'thread-1', accountId: MESHY, name: 'Chair', source: { kind: 'words', words: 'a wooden chair' }, root: '/home/zach/work', folder: '/home/zach/work/models',
      formats: ['glb', 'usdz'], triangles: 30000, state: 'making', stage: 'texture', credits: 30, askedAt: TIME, files: [], job: { preview: 'task-1', refine: 'task-2', asking: 'refine' } },
    { id: 'model-2', threadId: 'thread-2', accountId: MESHY, name: 'Lamp', source: { kind: 'photo', fileName: 'lamp.png' }, root: '/home/zach/work', folder: '/home/zach/work/models',
      formats: ['glb'], state: 'done', credits: 20, askedAt: '2026-11-19T10:00:00.000Z', endedAt: '2026-11-19T10:05:00.000Z', files: ['lamp.glb'], still: 'lamp-still.png', job: { photo: 'task-3' } },
    { id: 'model-3', threadId: 'thread-2', accountId: MESHY, name: 'Vase', source: { kind: 'words' }, root: '/home/zach/work', folder: '/home/zach/work/models', formats: ['stl'],
      state: 'failed', credits: 0, askedAt: '2026-11-18T10:00:00.000Z', endedAt: '2026-11-18T10:01:00.000Z', files: [], failure: 'no-credits', job: {} },
  ], spent: [{ accountId: MESHY, askedAt: '2026-11-17T10:00:00.000Z', credits: 10 }] } },
  { file: 'sounds.json', rust: 'plugins::tests::node_sounds_survives_a_rust_load_and_save', parse: parseSoundRecords, store: { version: 1, sounds: [
    { id: 'sound-1', threadId: 'thread-1', accountId: SOUNDS, kind: 'speech', name: 'Welcome', words: 'Hello there', voice: 'voice-1', seconds: 2.5, folder: '/home/zach/work/sounds',
      fileName: 'welcome.mp3', bytes: 40000, cost: 0.25, askedAt: TIME, state: 'made' },
    { id: 'sound-2', threadId: 'thread-2', accountId: SOUNDS, kind: 'effect', name: 'Door', folder: '/home/zach/work/sounds', cost: 0.5, askedAt: '2026-11-19T10:00:00.000Z', state: 'failed', failure: 'busy' },
  ], spent: [{ accountId: SOUNDS, askedAt: '2026-11-17T10:00:00.000Z', cost: 0.75, id: 'sound-0' }] } },
  { file: 'paired-clients.json', rust: 'pairing::tests::node_paired_clients_survives_a_rust_load_and_save', parse: parsePairedClientsFile, store: { secret: 'A'.repeat(43), clients: [
    { clientId: '11111111-1111-4111-8111-111111111111', name: 'Zach\'s iPhone', pairedAt: TIME, tokenHash: 'hash-1' },
    { clientId: '22222222-2222-4222-8222-222222222222', name: 'Forge', pairedAt: '2026-11-21T10:00:00.000Z', tokenHash: 'hash-2' },
  ] } },
  { file: 'phone-access.json', rust: 'phone_access::tests::node_phone_access_survives_a_rust_load_and_save', parse: parsePhoneAccessRecord, store: { port: 41234, mapped: true, servePort: 10000 } },
  // A set in Node, written sorted by Rust, so in sorted order here.
  { file: 'phone-clients.json', rust: 'phone_access::tests::node_phone_clients_survives_a_rust_load_and_save', parse: parsePhoneClients,
    store: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] },
  { file: 'local-apps.json', rust: 'phone_access::tests::node_local_apps_survives_a_rust_load_and_save', parse: parseLocalAppsFile,
    store: { version: 1, port: 51234, token: 'local-token-1', clientId: '44444444-4444-4444-8444-444444444444' } },
  { file: 'watcher-record.json', rust: 'watcher::tests::node_watcher_record_survives_a_rust_load_and_save', parse: parseWatcherRecordFile, store: { watcher: {
    version: 1,
    current: identity('watcher-1', '5abe6b7c-8d9f-4f0a-9b1c-c4d5e6f70819'),
    promptTurns: [{ id: '6bcf7c8d-9e0a-4a1b-8c2d-d5e6f708192a', watcher: target('watcher-1'), createdAt: TIME, rootUserMessageId: 'm-1', nativeTurnId: 'turn-1', previousNativeTurnId: 'turn-0' }],
    lastRuntimeMode: 'full-access',
    watches: [{ id: '7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b', target: target('t-1'), createdAt: TIME, generation: 2, pausedByUserMessageId: null, lastUserMessageId: 'm-2', parked: true, remoteOrigin: origin }],
    readyPullRequests: [{ target: target('t-1'), url: 'https://github.com/millZach/Sotto/pull/1', head: '0123456789abcdef0123456789abcdef01234567', at: TIME }],
    watchFences: [{ id: '8de19eaf-1a2c-4c3d-8e4f-f708192a3b4c', target: target('t-2'), remoteOrigin: origin }],
    userUnwatches: [{ target: target('t-2'), watcherHead: null, at: TIME }],
    localTakeovers: [{ target: target('t-1'), at: TIME, lastRequestId: REQUEST, userDrafts: [{ draftId: '9ef2afb0-2b3d-4d4e-9f5a-08192a3b4c5d', digest: DIGEST, messageId: 'm-3' }] }],
    remoteMasters: [{ clientId: 'client-1', masterHostId: MASTER_HOST, creationOperationId: '4fad5a6b-7c8e-4e9f-8a0b-b3c4d5e6f708', createdAt: TIME }],
    creation: null,
    history: [identity('watcher-0', 'a0f3b0c1-3c4e-4e5f-8a6b-192a3b4c5d6e')],
    requests: [{ id: REQUEST, watcher: target('watcher-1'), rootUserMessageId: 'm-1', standingWatchId: '7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b',
      displayPrompt: { originalLength: 12, wireDigest: DIGEST }, pairedPermissionCeiling: 'approval-required', state: 'active', createdAt: TIME, closedAt: null,
      userFollowups: [{ draftId: 'b104c1d2-4d5f-4f6a-9b7c-2a3b4c5d6e7f', messageId: 'm-4', afterTakeover: true }],
      participants: [{ requestId: REQUEST, startedBy: 'watcher', generation: 2, state: 'participating', target: target('t-1'), lastUserMessageId: 'm-2', promptCount: 1 }] }],
    operations: [{ id: OPERATION, requestId: REQUEST, retryKey: 'c215d2e3-5e6a-4a7b-8c8d-3b4c5d6e7f80', digest: DIGEST, promptTurnId: '6bcf7c8d-9e0a-4a1b-8c2d-d5e6f708192a',
      standingWatchId: '7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b', inputDigest: DIGEST, action: 'send', target: target('t-1'), generation: 2, deliveryState: 'accepted',
      createdAt: TIME, updatedAt: TIME, receiptId: 'r-1', cardId: 'c-1', messageId: 'm-5', outcome: 'answered', outcomeAt: TIME, turnMessageId: 'm-6', nativeTurnId: 'turn-2', replyMessageId: 'm-7' }],
    reservations: [{ target: target('t-1'), requestId: REQUEST, operationId: OPERATION, generation: 2, reason: 'active-turn' }],
    reads: [{ target: target('t-1'), position: { historyEpoch: 'epoch-1', afterPosition: 3 }, readAt: TIME, lastWakeEventId: 'e-1' }],
    remoteAbsences: [{ operationId: 'd326e3f4-6f7b-4b8c-9d9e-4c5d6e7f8091', master: identity('watcher-9', 'e437f4a5-7a8c-4c9d-8eaf-5d6e7f8091a2'), clientId: 'client-1', observedAt: TIME }],
    wakeEventIds: ['e-1'],
  } } },
  { file: 'watcher-state.json', rust: 'watcher::tests::node_watcher_state_survives_a_rust_load_and_save', parse: readKept, store: {
    decisions: [{ id: 'd1', text: 'Ship the fix', touchedAt: TIME, closedAt: TIME, closedNote: 'Shipped' }],
    rules: [{ id: 'r2', text: 'Ask before merging', touchedAt: TIME }],
    issues: [{ id: 'i3', text: '#2880 is open', touchedAt: TIME }],
    updatedAt: TIME, nextId: 4 } },
  { file: 'watcher-questions.json', rust: 'watcher::tests::node_watcher_questions_survives_a_rust_load_and_save', parse: parseWatcherQuestionsFile, store: { version: 1, questions: [
    { id: 'f548a5b6-8b9d-4dae-9fb0-6e7f8091a2b3', watcherThreadId: 'watcher-1', question: 'Settle t-1?', options: [{ label: SETTLE_IT, description: 'Stop watching it.' }, { label: KEEP_WATCHING }],
      settle: target('t-1'), state: 'answered', choice: SETTLE_IT, at: TIME, endedAt: TIME, spent: true, askedUnder: REQUEST },
    { id: '0659b6c7-9cae-4ebf-8ac1-7f8091a2b3c4', watcherThreadId: 'watcher-1', question: 'Which one?', options: [{ label: 'First' }, { label: 'Second' }], state: 'open', at: TIME },
  ] } },
  { file: 'watcher-told.json', rust: 'watcher::tests::node_watcher_told_survives_a_rust_load_and_save', parse: parseWatcherToldFile, store: { version: 1, events: [
    { ...event('e-1', 'thread-told'), told: { words: 'Done with the fix', userWords: 'Ship it', userWordsCut: true, opened: false } },
    { ...event('e-2', 'thread-ready'), ready: { pullRequest: 'https://github.com/millZach/Sotto/pull/2855', head: '0123456789abcdef0123456789abcdef01234567' } },
    { ...event('e-3', 'user-answered'), answered: { questionId: 'f548a5b6-8b9d-4dae-9fb0-6e7f8091a2b3', question: 'Settle t-1?', choice: SETTLE_IT, settle: true, opened: true } },
    { ...event('e-4', 'thread-moved'), turnId: 'turn-1', requestCardId: 'card-1', requestCardKind: 'question', revision: 'rev-1', operationId: OPERATION, backgroundWorkCount: 2,
      evidenceIds: ['ev-1'], delegatedThreadId: 't-3', answeredByUser: true, endedWithoutAnswer: true,
      swarm: { id: '1760c7d8-0dbf-4fc0-9bd2-8091a2b3c4d5', count: 3, done: 1, failed: 0, queued: 2 }, restartedBy: 'limit', restartCause: 'work-left',
      moveId: '2871d8e9-1ec0-4ad1-8ce3-91a2b3c4d5e6', movedTo: target('t-4'), moveOutcome: 'moved', machine: 'forge' },
  ] } },
  // Out of thread order on purpose: Node keeps its records in the order they came, and so must a Rust save.
  { file: 'limit-restarts.json', rust: 'watcher::tests::node_limit_restarts_survives_a_rust_load_and_save', parse: parseLimitRestartFile, store: { version: 1, threads: [
    { threadId: 't-b', provider: 'claude', stoppedAt: TIME, at: '2026-11-20T15:00:00.000Z', restarts: 1, sent: true, cause: 'work-left', turnId: 'turn-1' },
    { threadId: 't-a', provider: 'codex', stoppedAt: TIME, restarts: 0 },
  ] } },
  { file: 'followups.json', rust: 'watcher::tests::node_followups_survives_a_rust_load_and_save', parse: parseFollowupStore, store: {
    items: [{ id: '3982e9fa-2fd1-4be2-9df4-a2b3c4d5e6f7', threadId: 't-1', draftId: '4a93fa0b-3ae2-4cf3-8e05-b3c4d5e6f708', text: 'Sotto’s wake-up', attachments: [],
      createdAt: TIME, updatedAt: TIME, status: 'paused', error: 'Watcher stopped this thread.', commandId: 'command-1', messageId: 'm-1', resumeAfterTurnId: 'turn-1',
      wakeUp: true, pausedBy: 'watcher', watcherOperationId: OPERATION,
      news: [{ source: 'watcher', watcher: target('watcher-1'), omitted: 0, events: [{ id: 'e-1', kind: 'turn-finished', requestId: REQUEST, target: target('t-1'), generation: 1, observedAt: TIME }] }],
      phoneOrigin: { kind: 'phone', hostId: HOST, clientId: 'phone-1' }, nodeOnlyField: 'kept' }],
    receipts: [{ threadId: 't-1', draftId: '4a93fa0b-3ae2-4cf3-8e05-b3c4d5e6f708', digest: DIGEST, nodeOnlyField: 'kept' }],
    nodeOnlyField: 'kept' } },
]

/** Each store a Rust host creates records in, with the Rust test that writes one. `list` names the array Node keeps only the entries of it reads. */
const CREATED: readonly { file: string; rust: string; parse: (value: unknown) => unknown; list?: string }[] = [
  { file: 'councils.json', rust: 'council::tests::rust_created_councils_reads_in_node', parse: value => councilFileSchema.parse(value) },
  { file: 'checkpoints/checkpoints.json', rust: 'checkpoints::tests::rust_created_checkpoints_reads_in_node', parse: parseCheckpointStorage },
  { file: 'plugin-use.json', rust: 'plugins::tests::rust_created_plugin_use_reads_in_node', parse: parsePluginUses, list: 'uses' },
  { file: 'plugin-mail-grants.json', rust: 'plugins::tests::rust_created_plugin_mail_grants_reads_in_node', parse: parseMailGrants, list: 'grants' },
  { file: 'plugin-account-copy-choices.json', rust: 'plugins::tests::rust_created_plugin_account_copy_choices_reads_in_node', parse: parsePluginCopyChoices },
  { file: 'plugin-meshy-spending.json', rust: 'plugins::tests::rust_created_plugin_meshy_spending_reads_in_node', parse: parseHeardSpending },
  { file: 'paired-clients.json', rust: 'pairing::tests::rust_created_paired_clients_reads_in_node', parse: parsePairedClientsFile },
  { file: 'phone-access.json', rust: 'phone_access::tests::rust_created_phone_access_reads_in_node', parse: parsePhoneAccessRecord },
  { file: 'phone-clients.json', rust: 'phone_access::tests::rust_created_phone_clients_reads_in_node', parse: parsePhoneClients },
  { file: 'local-apps.json', rust: 'phone_access::tests::rust_created_local_apps_reads_in_node', parse: parseLocalAppsFile },
  { file: 'local-apps/paired-clients.json', rust: 'phone_access::tests::rust_created_local_apps_reads_in_node', parse: parsePairedClientsFile },
  { file: 'watcher-state.json', rust: 'watcher::tests::rust_created_watcher_state_reads_in_node', parse: readKept },
  { file: 'watcher-questions.json', rust: 'watcher::tests::rust_created_watcher_questions_reads_in_node', parse: parseWatcherQuestionsFile },
  { file: 'limit-restarts.json', rust: 'watcher::tests::rust_created_limit_restarts_reads_in_node', parse: parseLimitRestartFile },
  { file: 'followups.json', rust: 'watcher::tests::rust_created_followups_reads_in_node', parse: parseFollowupStore },
]

describe.skipIf(!RUN_RUST_HOST)('shared stores across a Rust host and a rollback to Node', () => {
  const dirs: string[] = []
  const folder = async () => { const dir = await mkdtemp(join(tmpdir(), 'sotto-rust-shared-stores-')); dirs.push(dir); return dir }
  const runRust = runRustStoreTest
  const read = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown

  afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

  it.each(STORES.map(store => store.file))('%s reads in Node after a Rust load and save exactly as before', async file => {
    const { rust, parse, store } = STORES.find(entry => entry.file === file)!
    // What Node reads of the store as Node wrote it; a fixture Node itself would refuse fails here.
    const before = parse(store)
    const dir = await folder()
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), JSON.stringify(store, null, 2))
    runRust(rust, dir)
    expect(parse(await read(dir, file))).toEqual(before)
  }, 600_000)

  it.each(CREATED.map(store => store.file))('%s that a Rust host created reads in Node', async file => {
    const { rust, parse, list } = CREATED.find(entry => entry.file === file)!
    const dir = await folder()
    runRust(rust, dir)
    const written = await read(dir, file)
    const parsed = parse(written)
    expect(parsed).toBeTruthy()
    if (list) expect(parsed).toHaveLength((written as Record<string, unknown[] | undefined>)[list]?.length ?? -1)
  }, 600_000)
})
