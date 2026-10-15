# Terminal clipboard shell fixture

October 14, 2026, PR #1034 follow-up.

The unchanged real-shell case in `tests/unit/main/terminalClipboard.test.ts` expired at the global 15-second deadline in PR #1016's Windows job `116009404344` (15,003 ms), and again in PR #1034's Windows job `116064641235` (15,018 ms). The latter shard otherwise passed 1,474 tests and skipped 66. The case and production formatter were unchanged between those heads. The first isolated complete three-case file passed, and the complete normal gate on `1be3073e4510bf48d0d83ff840e8b31eb8ee6063` passed 10,800 tests and skipped 345 with all 6,220 tracked file hashes frozen.

Those passes do not identify the phase pending in CI. The previous fixture had no child deadline or cancellation, left unused stdin open, and gave no spawn, output, exit or close evidence. No production quoting defect, cold-start cause or stdin deadlock has been established.

The two synchronous quoting cases remain in unit tests. The actual platform-shell case now lives in `tests/integration/terminalClipboardShell.test.ts`, preserving the sensitive input, Windows PowerShell fallback executable and flags, POSIX command, formatter call and exact output assertion. Its explicit 60-second child bound matches the existing native Node probe's bound; the enclosing 75-second case leaves time to drain the child. These are failure bounds, not latency assertions, and add no time to a successful run.

The fixture retains its own child handle, closes unused stdin, passes the test's cancellation signal, and kills and awaits only that child's close at test completion. The child command starts no descendants. Fixed phase booleans and a native error code distinguish a future spawn/output/exit/close failure without printing arguments or output. Production code, global deadlines, retries and parser behavior are unchanged. No warm-up shell, real sleep, fixture bypass or skipped assertion was added.

The two unit cases and the integration round trip passed together on Windows: three cases, native exit 0, in 1.22 seconds. This addresses a native fixture's classification, bounded lifetime and diagnostics. It does not claim that the exact CI delay was reproduced. The full normal gates remain required before pushing this follow-up.
