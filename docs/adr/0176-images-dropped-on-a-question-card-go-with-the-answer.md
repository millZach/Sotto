# Images dropped on a question card go with the answer

## Status

Accepted November 2, 2026, at Drake's request. It is an Owl feature (`answer-images`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), Drake's call. No mock-up: it adds an affordance to the question card, which already exists, and reuses the composer's image chips and drop edge.

## Context

A question often wants a picture as its answer: which of these looks right, what does it show on your screen. The composer takes dropped and pasted images, but a question card took words and choices only, and answers reach every provider as text. Claude's AskUserQuestion result, Codex's request_user_input response, and the ACP providers' form answers carry no image block, so an answer cannot carry an image the way a prompt does.

## Decision

**1. A question that takes the user's own words takes images too.** In a thread pane, while the thread's model reads images, dragging images over the card's questions shows the composer's drop edge. Dropping or pasting them adds them under the questions as the composer's chips, with the composer's limits, scaling (ADR-0030) and staging (ADR-0031). A paperclip beside them picks files, and **Send answer** waits while any are still being added. Images only: with **Attach any file** on (ADR-0131), the card still refuses other files. Which questions those are is the adapter's to say: an agent's own question tool (Claude Code's AskUserQuestion, Codex's request_user_input, Grok Build's and Muse's questions) marks each question whose written answer reaches the agent as words `prose`, with or without choices. A typed form field (Codex's MCP forms, OpenCode's and Devin's forms, Cursor's questions) is never marked, since it may be a number or a date the provider checks, and takes none. Nor do a question with only choices, a permission, a plan, and a card in Needs you or Watcher's conversation. Images answer the question they go in on their own, so a required question that wants words can be answered with a picture alone, and images on a form with nothing else chosen make it an answer, so its button says **Send answer** rather than skip.

**2. The images go as files named in the answer's words.** As the answer is about to reach the provider, after its saved draft is bound to what the user chose, main checks the images are still kept and saves each one in the thread's folder under `.sotto/attachments/`, as an attached file is (ADR-0131). It adds the `<sotto-attached-files>` note naming them to the words of the form's last `prose` question, after any words the user wrote there. Every provider reads that note as part of the answer, and the agent opens the files by path. No adapter changed. Main refuses images on any other answer, a skip, a permission, and on a build with `answer-images` off, before anything is saved or sent. An answer to Sotto's own copy of a question (ADR-0108) goes as the user's message, so its images go with it as a prompt's do.

**3. The card's images live in the window until they are sent.** They are kept by the card's thread and question, so moving to another thread and back keeps them, but they are not saved with the question's draft and nothing in main owns them. After an hour (ADR-0031's sweep) an unsent image is gone and sending says so; the user adds it again. Answering from the composer, as a question without choices is answered, stays text only, and a composer send that would answer a question with images is still refused.

## Consequences

- The agent sees the images only if its model reads image files, the reason the card offers them only on a model that reads images.
- A question answered with images leaves files in the working folder's git-ignored `.sotto/attachments/`, as attached files do.
- A question asked as a typed form takes no images, even where its field is free text; marking those needs each form's field formats read, which no adapter does yet.
- A remote host takes images on an answer only on its own Owl answer for `answer-images`; an older host refuses the field.
- Stable shows no drop edge, no chips and no paperclip on a question card, and its main refuses an answer that carries images.

November 4, 2026 amendment (#2153, [ADR-0005](0005-codex-app-server-adapter.md)): a question marked secret, a **secret answer**, takes no images and is never the question images are named in, even when it is `prose`. Its words are masked and never saved, and a note added to them would be both.
