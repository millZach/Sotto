# Threads render cost

What the window re-renders when one agent state update arrives. Measured with

```
npx vitest run tests/perf/threadsRender.perf.test.tsx --disable-console-intercept
```

over a copy of the local Sotto data folder (5 threads, 48 messages, the open thread holding 31), with the
Threads page mounted and one thread open. Each update is a whole new state object off the wire with one more
streaming chunk appended to the open thread's newest reply — what arrives many times a second while an agent
works. Medians of 20 updates, Windows 11, jsdom, dev build.

`msPerUpdate` is the median wall time from receiving the state to the commit being painted.
`reactMsPerUpdate` is React's own `actualDuration` for the committed tree, averaged over the updates.

## Before (perf/state-pipeline at beb2af3)

| | |
| --- | ---: |
| Updates | 20 |
| Commits | 20 |
| ms per update | 67.3 |
| React ms per update | 53.7 |

Everything under `AgentProvider` re-renders: `setSnapshot` replaces the whole state object, so `ThreadsView`
re-derives its rows and organization, every sidebar row re-renders, and every message in the open pane is
rebuilt even though only one message's text changed.
