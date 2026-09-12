# Manual thread composer: September 11, 2026

The reported screenshot replaced the composer with “Your saved draft belongs to test.”
`ThreadsView` checked for a foreign coordinator draft before choosing the managed or
manual composer. `AgentControl.sendManual` also rejected any send while another
thread held that draft. Separately, running status disabled the entire manual editor.

Acceptance checks:

- [x] A foreign saved draft does not hide an unmanaged thread's composer.
- [x] Manual sends target the selected thread and preserve the foreign text, images,
  and question binding without granting management.
- [x] Draft preservation and delivery receipts survive uncertain acknowledgement
  and restart; retry does not duplicate delivery.
- [x] Typing remains available during a running turn; both Send and Ctrl+Enter wait
  for completion. Navigation between manual threads retains their local text.
- [x] Pending permissions still require an explicit answer.
- [x] Inspect the built Electron workflow and screenshot.

Red reproduction: `npx vitest run tests/unit/renderer/threadsView.test.tsx tests/unit/main/threadNavigationDelivery.test.ts -t 'unmanaged composer|manual prompt on B'`
failed with a missing Prompt textbox and “Send or clear the existing draft before
prompting another thread.” Both pass after the fix.

Final verification: 182 tests across thread navigation/delivery, attention,
controller recovery, renderer threads/composer/queue, and options/attachments;
three Playwright Electron journeys in `thread-workspace.spec.ts`; node/web
typecheck, targeted ESLint, production build, and whitespace check passed.
Inspected `artifacts/crossing/thread-workspace-foreign-draft.png`.

Scope: composer behavior and regression coverage. Electron verification used an isolated fixture
provider; no live provider messages or changes to the user's running app. The
coordinator still has one persistent draft; other manual editor text remains local
to the Threads view. This change does not add persistence for every manual draft.

September 12 integration check: after merging the native-provider and memory
batch, typecheck and all 104 tests across the four affected composer, navigation,
attention, and attachment suites passed with these edits restored. The original
added and removed lines were preserved exactly during integration.
