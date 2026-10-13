# Answer recovery passes

October 10, 2026. On 0.1.35 the desktop lagged by seconds: a click took seconds to land, typing trailed by several
words, and one send took over two minutes. Measured in the installed app on the development machine (195 threads,
a local and a remote host, one saved answer held on a thread on the remote host), by opening main's inspector on
127.0.0.1 and attaching non-pausing probes. No message, title or answer text was read; only counts, sizes and timings.

## What main was doing

Main's JavaScript heap held 1.48 GB eight minutes after launch, and its UI thread, which also delivers the window's
input, used 56% of a core with no thread streaming. A 10.6 s CPU profile put 1.98 s inside answer recovery, 1.90 s of
it in `AgentControl.get()`.

Every published state started a recovery pass (`DesktopHostRouter.reconcileRequestDrafts`), and each pass reconciled
the held answer twice. Each reconcile looked the answer's thread up once or twice, and the lookup in `src/main/index.ts`
read this computer's host ID as `agentControl.get().hostId`. `get()` copies every loaded thread's history: here
108 MB of activity records across the 195 threads.

| Call, on this data | Median |
| --- | ---: |
| `AgentControl.get()` | 214 ms (433 ms measured in place, under collection pressure) |
| `DesktopHostRouter.shell()`, both hosts | 9.5 ms |
| `AgentControl.shell()` | 2.1 ms |
| The held answer's lookup, before | 253 ms |
| The held answer's lookup, after | 5.9 ms |

The state publisher sends at most once per 50 ms window, so a streaming provider asks for up to twenty passes a second.
Each one cost between half a second and a second, and the passes queued on the draft service's serial lane without
bound, so main went on draining them for minutes after a reply ended.

## After

- The lookup reads `agentControl.hostId()`, which copies nothing. It moved to `src/main/agents/requestDraftOwners.ts`
  so a test can reach it.
- Published states ask the router for a pass with `scheduleRequestDraftReconcile`. Passes run one at a time and start at
  least `REQUEST_DRAFT_PASS_INTERVAL_MS` (500 ms) apart, and asking during a pass, or before that interval since its start
  is up, gets one more pass when both are over. A pass ends once its receipt reads are issued, so it never waits on
  another pass's socket read.
- A pass builds the router's shell only when a held remote answer still needs its receipt.

A pass on this data now costs about 18 ms (two 5.9 ms lookups and one 6.2 ms shell), at most twice a second: under 4%
of main while a provider streams, against more than all of it before.

`tests/unit/main/desktopHostRouterRecovery.test.ts` reconciles a held remote answer against a real coordinator and fails
if `get()` is called; before the fix one pass and one reconcile called it nine times. The same file covers the pass
bound, a pass slower than the interval, and the lookup with this computer's host off.
