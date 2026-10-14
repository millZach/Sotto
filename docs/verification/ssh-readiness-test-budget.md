# SSH readiness test budget

October 5, 2026, PR #737 review follow-up.

Windows CI run `37354450850` failed only the two SSH readiness cases, `started` and `discovered`, at 15,032 and 15,014 milliseconds. All 41 other cases in that file passed. The combined PR #738 revision `c14a8f55` passed the whole Windows gate in run `37354509482`; its SSH launcher, askpass broker, fake SSH process and test source are identical to the failing revision. On that green runner the first readiness case took 7,487 milliseconds and the second 515 milliseconds.

The unchanged full SSH suite also passed locally: 43 tests in 42.32 seconds. A focused readiness rerun passed in 658 and 587 milliseconds. This does not identify the exact stage that consumed the failed runner's time: its log has no stage trace.

The test's awaited path includes a version-check child, compiling Windows' askpass helper, resolving the route, launching the host, opening and verifying the forward, requesting a pairing code, and closing the connection. The helper compilation itself legitimately has a 15-second deadline; authentication has 120 seconds and host readiness 30 seconds. Child shutdown is bounded at two seconds, and broker close destroys its sockets before closing its listener. No fixed sleep or unbounded child-exit wait was found in these cases.

The default 15-second test deadline could therefore expire while a valid helper compilation was still within its own budget, before the remaining journey completed. The two cases now use the same 150-second test deadline as the existing password connection journey. Assertions still check readiness, forwarded identity, ownership, pairing, status, command order and close behavior. Production timeouts and the global test deadline are unchanged. This is not a claim that the exact failed-run stage was reproduced locally.

After the localized deadline change, `npx vitest run tests/integration/sshLauncher.test.ts --maxWorkers=2` passed all 43 tests in 39.70 seconds. No full local app suite was repeated; the latest Windows CI gate remains required before merge.

## Host update journey, October 14

Main commit `00f32d33da2e636fe82fb9e7a189c0c082753dd7`, run `38618517874`, Windows shard 4/6 failed only the host-update journey at 15,338 ms. The shard otherwise passed 1,626 tests and skipped 63. The unchanged case passed in isolation on Windows with exit 0; all 6,220 tracked files remained unchanged. The test, launcher, launch script, fake SSH processes, archive fixture and Vitest configuration have identical Git blobs at the prior Muse merge `0e0d8749ab0030faa39a2594b01de97de9c89426`.

This case already allowed 30 seconds for each host start, but its enclosing test still used the global 15-second deadline. It connects and starts an owned host, downloads and checks an archive from a loopback server, unpacks it, then stops and starts the host again. Its enclosing deadline now matches the existing readiness and password journeys at 150 seconds. Assertions, production operation budgets, cleanup and the global deadline are unchanged. No real delay or new timing assertion was added.

The CI log does not identify the phase pending at expiry. This corrects the enclosing test's inconsistent failure bound; it does not establish a production defect or claim that the exact CI delay was reproduced locally.

After the scoped change, `npx vitest run tests/integration/sshLauncher.test.ts --maxWorkers=2` passed all 46 cases on Windows in 41.27 seconds, including the update and its neighbouring cancellation, archive-copy and boot journeys. The update case took 1,426 ms. The full gates and latest Windows CI still decide merge readiness.
