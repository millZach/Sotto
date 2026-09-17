# Markdown rendering while a reply streams

`MessageContent` renders a message with `react-markdown` + `remark-gfm`. While a provider is writing,
every chunk used to re-parse the whole message, so the cost of a reply grew with the square of its
length. `tests/perf/markdownRender.perf.test.tsx` measures that: a ~5.5 KB assistant reply (headings,
prose with inline code, a bulleted and a numbered list, three fenced code blocks and a table) is fed
in 40 appends and each render is timed.

Two numbers are reported per run:

- **ms per chunk** — median and total of the 40 `rerender` calls, jsdom, Windows 11, one worker.
  Machine-dependent; compare only within a single run.
- **parsed characters** — the characters Markdown is parsed over across the whole stream, counting a
  memoised block once. Deterministic, so it is the number to compare between commits.

## Before

At `10cc813`, with `splitStreamingMarkdown` splitting the stream only when the *next* line after a
blank line cannot be claimed by what precedes it.

| Strategy | Median ms/chunk | Total ms | Parsed characters |
|---|---|---|---|
| Re-parse the whole message each chunk | 8.5–10.1 | 336–438 | 113,960 |
| Incremental (stable prefix memoised) | 3.6–5.2 | 183–234 | 30,860 |

Incremental parses 3.7× fewer characters and is about 1.9× faster in wall time; the gap between the
two ratios is React reconciliation and jsdom DOM work, which the split does not remove.

Where it still fell short: a closed code fence stayed in the unstable tail whenever the block after it
was a list, a quote or an indented line, because those can continue the block above them. "Here is the
code, and here is what it does" — a fence followed by bullets — is the commonest shape in an agent
reply, and it re-parsed and re-highlighted the whole fence on every chunk until a paragraph or heading
finally arrived.
