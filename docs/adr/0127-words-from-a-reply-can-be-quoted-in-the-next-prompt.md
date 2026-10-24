# Words from a reply can be quoted in the next prompt

## Status

Accepted October 24, 2026, as an Owl feature (`reply-quote`). The user picked A, one **Add to prompt** button above the selection, and 1, a chip like a review comment's, of `docs/prototypes/reply-quote-prototype.html`. Builds on review comments (#270) and [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). **Number provisional until merge** (docs/agents/domain.md).

## Context

A follow-up often points at part of the agent's last reply: "do the first one", "why this line?". Today the user copies the words, pastes them into the composer and writes around them, or describes them and hopes the agent finds the same passage. Claude Code Desktop puts a button on a selection that sends it to the prompt. Sotto already carries one kind of quoted material with a prompt, the **review comment**, as plain text after the user's message, held in the window until sent.

## Decision

**1. A selection in a reply offers Add to prompt.** When both ends of a selection lie in the text of the same agent reply in a thread's transcript, a small button labelled **Add to prompt** appears above it, or under it when the top of the transcript would cut it off, and follows it as the transcript scrolls. A selection that runs into another message, a message header or the user's own words offers nothing. Escape puts the button away and clears the selection. The press takes the selection's text, clears the selection and puts focus in that thread's composer.

**2. The keyboard has a chord.** Ctrl+Shift+A, Command+Shift+A on a Mac, adds the selection the same way while it lies in a reply. It collides with no dictation default (Ctrl+Shift+Space, Control+Shift+Space on a Mac, Super+Ctrl+X on Linux, and the hold shortcuts Fn, Ctrl+Win and F9) and no shortcut of Sotto's own; like the branch toolbar's chords it stands down when the user's dictation hotkey is those keys, and it is never taken from a terminal.

**3. The quote waits as a chip.** Each press adds a **reply quote** to the thread's composer, drawn as a review-comment chip: the quote icon, the first six words in curly quotes with an ellipsis, the whole text as its title and for a screen reader, and **Remove quote**. A prompt carries at most 20; past that the button says so instead of adding one. Quotes are held in this window's memory only, like review comments: not saved with the draft, never logged, gone when sent, removed or the window closes. Each keeps the message ID of the reply it came from.

**4. They go as plain text, ahead of the message.** On send, queue, steer or a continuation's first message, the prompt's own text becomes each quote as

```
From your earlier reply:
> line
> line
```

then the user's message, then any review comments, joined by blank lines. Blank lines around a quote are dropped, but its first line keeps its indentation. Quotes come first so the message's "this" has something to point at. Plain text means every provider reads the same thing, the transcript shows what was sent (the user's bubble draws the blockquote), and a refused prompt comes back to the composer with the quotes written in. A continuation's first message carries them in its request alone until the new thread starts, so a refused continuation leaves the draft and the chips as they were and a retry carries each quote once. An answer to a question carries none; the composer says they wait for the next prompt.

**5. No sent-quote view.** The sent message is the user's text like any other. There is no special bubble and no jump back to the reply; the prototype's sketch of one was not picked.

**6. Stable shows nothing of it.** The transcript asks `useOwlFeature('reply-quote')` before it offers the button or listens for the chord, and the composer asks before it shows a chip or writes a quote into a prompt. Main has no part.

## Consequences

- `CONTEXT.md` names the **reply quote**. The design captures do not change: nothing is selected in them.
- The quote's text is the selected part of the reply read as plain text, the way a reply's copy control copies it as plain text: a code block's language and Copy control and text kept for screen readers are left out, code keeps its indentation, and a code block arrives as its lines without its fence. Markdown emphasis and links are lost. Quoting the reply's Markdown source for the selected range would keep them; it is not worth the mapping yet.
- A quote is the user's evidence for the agent, like any prompt text. It answers nothing and grants nothing.
- Sending the feature to stable flips its entry's `sentToStable`.
