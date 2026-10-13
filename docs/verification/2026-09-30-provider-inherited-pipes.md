# Provider shutdown with inherited output pipes

S-060 / #533, verified on Windows with synthetic Node subprocesses.

`tests/integration/providerInheritedPipes.test.ts` starts each affected transport
against a subprocess that exits after its first request. Before exiting, it starts
a detached descendant that inherits stdout and stderr and keeps both open. The
test checks that the outstanding request and shutdown settle while that descendant
is still alive. Cleanup stops only the descendant recorded by the fixture.

Before the fix, all three cases failed because shutdown remained pending. Adding
the existing Grok/Devin transport pattern to Codex, Claude and subscription Grok
releases the output streams after `exit`, allowing `close` to settle the original
shutdown and failure handlers. Review identified that immediate destruction could
drop a final response still buffered in stdio. Each transport now allows 300 ms
for output to drain, on an unref'd timer cancelled by `close`.

`tests/integration/providerFinalOutput.test.ts` uses real children that write their
final response and exit immediately. The parent's stdout read is held until the
child exits, making Node's permitted exit-before-drain ordering deterministic.
All three cases failed with immediate destruction and pass with the grace period.
Codex and Claude receive the final response; Grok receives its final session
catalog and reports ready. The inherited-pipe tests still require settlement
while the descendant is alive.

The regression and neighboring Claude protocol, Grok subscription and Codex
session-process suites passed: 4 files, 31 tests. This verifies the inherited-pipe
lifecycle with real subprocesses, without paid provider calls. No renderer surface
changed, and no graphical or live provider journey was run.
