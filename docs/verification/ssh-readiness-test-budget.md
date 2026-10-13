# SSH readiness test budget

October 5, 2026, PR #737 review follow-up.

Windows CI run `37354450850` failed only the two SSH readiness cases, `started` and `discovered`, at 15,032 and 15,014 milliseconds. All 41 other cases in that file passed. The combined PR #738 revision `c14a8f55` passed the whole Windows gate in run `37354509482`; its SSH launcher, askpass broker, fake SSH process and test source are identical to the failing revision. On that green runner the first readiness case took 7,487 milliseconds and the second 515 milliseconds.

The unchanged full SSH suite also passed locally: 43 tests in 42.32 seconds. A focused readiness rerun passed in 658 and 587 milliseconds. This does not identify the exact stage that consumed the failed runner's time: its log has no stage trace.

The test's awaited path includes a version-check child, compiling Windows' askpass helper, resolving the route, launching the host, opening and verifying the forward, requesting a pairing code, and closing the connection. The helper compilation itself legitimately has a 15-second deadline; authentication has 120 seconds and host readiness 30 seconds. Child shutdown is bounded at two seconds, and broker close destroys its sockets before closing its listener. No fixed sleep or unbounded child-exit wait was found in these cases.

The default 15-second test deadline could therefore expire while a valid helper compilation was still within its own budget, before the remaining journey completed. The two cases now use the same 150-second test deadline as the existing password connection journey. Assertions still check readiness, forwarded identity, ownership, pairing, status, command order and close behavior. Production timeouts and the global test deadline are unchanged. This is not a claim that the exact failed-run stage was reproduced locally.

After the localized deadline change, `npx vitest run tests/integration/sshLauncher.test.ts --maxWorkers=2` passed all 43 tests in 39.70 seconds. No full local app suite was repeated; the latest Windows CI gate remains required before merge.
