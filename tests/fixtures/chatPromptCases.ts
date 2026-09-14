import type { ChatPromptTranscript } from '../../src/shared/chatPrompts'

export const chatPromptCases: { name: string; messages: ChatPromptTranscript['messages']; review: string }[] = [
  { name: 'short-missing-details', messages: [
    { id: 'u1', role: 'user', text: 'I want a simple timer for my tea. I have not decided which platform or how long the timers should be.' },
    { id: 'a1', role: 'assistant', text: 'We could offer presets and notifications. Would you prefer phone or desktop?' },
  ], review: 'Tea timer objective retained. Platform and durations remain open. Presets and notifications must not become requirements. No invented platform, duration or notification permission.' },
  { name: 'latest-correction', messages: [
    { id: 'u1', role: 'user', text: 'Build a reading app for my phone. Use a three-column layout with bookmarks synced to an account.' },
    { id: 'a1', role: 'assistant', text: 'I suggest adding recommendations and sharing.' },
    { id: 'u2', role: 'user', text: 'Correction: desktop only, one article at a time. Keep bookmarks local; no account or sharing. Deliver a working prototype. I should be able to save an article, close the app, and find it after reopening.' },
  ], review: 'Desktop, single article and local bookmarks replace phone, three columns and account sync. No sharing. Prototype and save/restart acceptance retained. Recommendations remain unaccepted.' },
  { name: 'unresolved-conflict', messages: [
    { id: 'u1', role: 'user', text: 'Design a team task list. It must always work offline and every edit must immediately appear for every teammate, even when their computers have no network.' },
    { id: 'a1', role: 'assistant', text: 'Those requirements conflict during disconnection. We could synchronize after reconnecting.' },
    { id: 'u2', role: 'user', text: 'I need to think about that tradeoff. Do not choose for me. We also have not chosen who may edit or delete tasks.' },
  ], review: 'Both demands retained as an unresolved conflict. Reconnect sync is only a suggestion. Editing/deletion authority remains open. No invented resolution or permission model.' },
  { name: 'long-brainstorm', messages: [
    { id: 'u1', role: 'user', text: 'I want a workshop inventory app to find my parts quickly. We should brainstorm before building.' },
    { id: 'a1', role: 'assistant', text: 'Possible directions: a photo catalog, a spreadsheet-like table, or a map of drawers.' },
    { id: 'u2', role: 'user', text: 'Use a searchable table. Each part has a name, quantity and drawer. The map seems distracting.' },
    { id: 'a2', role: 'assistant', text: 'We could add barcodes, reorder thresholds and supplier links.' },
    { id: 'u3', role: 'user', text: 'Supplier links would be useful later. Skip barcodes and automatic reordering for the first version.' },
    { id: 'a3', role: 'assistant', text: 'How should quantity changes work? Perhaps plus and minus buttons beside each row.' },
    { id: 'u4', role: 'user', text: 'Yes, use those quantity buttons. Never allow a negative quantity. Also allow editing a quantity directly.' },
    { id: 'a4', role: 'assistant', text: 'An undo history could help recover mistakes.' },
    { id: 'u5', role: 'user', text: 'For the prototype, just ask before deleting a part. Keep the interaction simple.' },
    { id: 'a5', role: 'assistant', text: 'Do you want the data on this computer or synchronized between devices?' },
    { id: 'u6', role: 'user', text: 'This Windows computer only. Store locally. I do not need accounts or cloud services.' },
    { id: 'a6', role: 'assistant', text: 'We can include CSV import and export. Should part photos be mandatory?' },
    { id: 'u7', role: 'user', text: 'Export to CSV is required. No import yet. Photos can wait too.' },
    { id: 'a7', role: 'assistant', text: 'A multi-page dashboard could show total value, part counts and recent activity.' },
    { id: 'u8', role: 'user', text: 'No dashboard. Open directly to the table, and search names and drawers from one search box.' },
    { id: 'a8', role: 'assistant', text: 'Should a duplicate part name merge quantities automatically?' },
    { id: 'u9', role: 'user', text: 'I have not decided how duplicates work. Keep that question open. Avoid automatic merges.' },
    { id: 'a9', role: 'assistant', text: 'We could store the supplier link as another table column now.' },
    { id: 'u10', role: 'user', text: 'Actually leave supplier links out of the prototype completely. Deliver the app and instructions for running it. Verify add, search, edit quantity, delete confirmation, restart persistence and CSV export. I will provide example parts later; do not invent my inventory.' },
  ], review: 'Searchable Windows local table, fields, quantity buttons/direct edit, nonnegative quantity, delete confirmation and CSV export retained. Latest supplier correction excludes supplier links. No dashboard/map/import/photos/barcodes/accounts/auto merges/reordering. Duplicate handling and example inventory remain open. Accepted quantity-button proposal distinguished from other suggestions; all named deliverables/checks retained.' },
]
