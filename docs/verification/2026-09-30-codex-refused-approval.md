# Codex refused approval notice

S-057 / #530, partial fix verified on Windows with the real adapter over a scripted
Codex app-server. Child-thread routing remains unverified and #530 stays open.

The integration regression sends an approval on a session's app-server with an
unknown thread ID. It failed before the fix: the server received `-32601` but the
snapshot carried no notice. It now checks refusal, a notice on the owning thread,
no pending request and no approval. A null thread ID is covered too. Known-thread
unreadable requests still report their existing copy; unrelated methods and
unknown requests on the provider-only app-server stay quiet.

The first Electron check showed that the old provider-level notice never reached
the Threads pane. The notice therefore travels on the owning thread as
`requestNotice` and uses the pane's existing alert. No child identity or payload
is inferred, and nothing is answered with an approval.

A throwaway prototype used the existing pane, alert markup and styles with the
requested copy. No new layout was proposed. The final journey,
`tests/e2e/codex-refused-approval.spec.ts`, then delivered the request through the
real adapter, coordinator, IPC and renderer. It checked the visible notice,
protocol refusal and absence of approval. All six combinations of dark/light and
1600x1000, 1280x800 and 820x560 passed visibility and overflow checks. Reduced
motion retained the notice. The kept screenshots were inspected:

- `artifacts/review-644/refusal-dark-1280.png`
- `artifacts/review-644/refusal-light-820.png`

Spec review found that an earlier command error could hide the refusal notice.
The notice now renders independently of command-error suppression. The Electron
journey leaves a refused model change's error in place before the child approval
arrives and verifies that the refusal notice still reaches the user.

The five existing `native-request-forms.spec.ts` journeys passed as well, covering
explicit native choices, refused/held answers, independent prompt drafts and
short stacked panes. No design baselines were regenerated. No live provider turn
or macOS execution is claimed.
