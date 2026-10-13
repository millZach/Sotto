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

## After

A closed fence that opened its own block at column 0 ends a leaf block, and nothing after the blank
line below it can reach back into it — not a list item, not a lazy quote, not an indented line. That
blank line is now a boundary on its own, without waiting to see what follows.

| Strategy | Median ms/chunk | Total ms | Parsed characters |
|---|---|---|---|
| Re-parse the whole message each chunk | 9.9–13.6 | 406–579 | 113,960 |
| Incremental, before this change | 3.6–5.2 | 183–234 | 30,860 |
| Incremental, after this change | 3.1–4.4 | 152–227 | 28,973 |

Parsed characters, the number that does not depend on the machine, fall 6% further: **113,960 → 28,973**,
a 3.9× reduction against re-parsing the whole message. Wall time on a quiet machine is about 2× faster
than re-parsing the whole message; the ms columns above were taken across nine runs on a busy laptop
and drift by half, so compare the two strategies within one run, never across runs.

## What is left

The dominant remaining cost is a fence while it is still open: the whole fence re-parses and
re-highlights on every chunk until its closing line arrives, which is roughly half the characters in
the table above. Splitting inside an open fence is not safe, so removing that would mean parsing and
highlighting the code incrementally rather than the Markdown.

Lists and tables are also never split internally: `- one` after a blank line can be the second item of
the list above it, and splitting it off would change a tight list into two lists. A reply that is one
long list re-parses that whole list on every chunk.

## Rules the splitter uses

A message being written is cut into blocks only where no Markdown construct can reach across the cut.
A cut is made at a blank line when either:

- the line before the blank closed a fenced code block that opened at column 0 and began its own block
  (so it is top level, not inside a list item or a quote), or
- the next non-blank line cannot be claimed by what precedes it: it does not begin with whitespace,
  `-`, `*`, `+`, `>`, `=`, a number followed by `.` or `)`, `[` or `<`, all of which can continue a
  list, a quote, indented code, a setext heading or an HTML block above them.

An unterminated fence is never cut through, and a message holding a link or footnote definition, or an
HTML block that runs past blank lines (`<script`, `<pre`, `<style`, `<textarea`, `<!--`, `<?`), is
rendered whole, because those resolve from anywhere in the message. When the message stops streaming
it is rendered as a single parse, so the final DOM is exactly what one parse produces;
`tests/unit/renderer/streamingMarkdown.test.tsx` asserts that for nineteen fixtures fed in 1, 3, 7 and
13 byte chunks.
