# A prototype waiting for review needs you

## Status

Accepted October 22, 2026, for issue #1351. Zach asked for both parts and picked variant A of the prototype on the tag `prototype/prototype-ready`. He asked for it to go straight to stable, not to be an Owl feature, and for the iPhone's own marks to follow in another issue. Builds on ADR-0085 (question pages). Amends ADR-0004 in one narrow place: Sotto may return a question to the thread that asked it, as set out below.

## Context

Watcher kept telling Zach "nothing needs you" while a prototype sat waiting for him. Only question and permission cards counted as needing him, so a thread that finished with "the prototype is at `docs/prototypes/x.html`" read as quiet. Separately, a question about a prototype that named no page he could open reached him anyway, and he had to send it back himself. ADR-0085 already finds the pages a question names and serves them to the phone under a token. It found nothing for a reply, and it offered a loopback page whether or not anything answered there. On the desktop, a page opened in the system browser whatever **Web links in threads** said.

## Decision

**A working page.** A page works when it opens from Zach's iPhone through Sotto and from the desktop in the browser **Web links in threads** chooses. An HTML file that ADR-0085 finds in the thread's folder works. So does a loopback address that answers a GET within a moment with a status below 400. A loopback address that does not answer is still offered on a question, as before, but it is not a working page.

**Prototype ready for review.** When a thread's newest reply, from a turn that has ended, names a working page, or a waiting question carries one, the host's coordinator marks the thread `prototypeReady`. The mark carries the working pages with their tokens and names its source: the reply or the question. It stays until Zach opens one of those pages, from the desktop or through the page route from the phone, or replies in the thread. A reply is a user message after the reply that named the page; a wake-up Sotto sent is not one. Answering the question is replying to it. A page opened is remembered by its source, and that memory is saved, so a restart does not bring the mark back. Showing the thread does not clear it. A reply written before the first start with marks earns none, so the update does not mark every old thread whose last reply named a page; that time is saved too.

- The Threads sidebar row says **Prototype ready**, and the thread pane shows **Prototype ready for review** above the composer with an **Open the prototype** row for each page.
- Watcher's needs-you line names the thread with "prototype to review", and the Overview puts it under Needs you.
- Watcher news has a `prototype-ready` event, sent once for each source while the mark stands. It says only that the user has a prototype to review, and like all news it answers and approves nothing.

**Checked prototype questions.** A question is about a prototype when its words, or the reply before it, say prototype or mock-up. While Sotto looks for such a question's pages, the coordinator holds the card: no client, Watcher or alert sees it. If the search ends with a working page, the card shows with its pages. If it does not, Sotto **sends the question back**: it answers the question once with this note, and with nothing else:

> Sotto held this question because it is about a prototype but names no page that opens. The user has not seen it. Ask it again with the prototype's file path in this folder or its loopback address, and make sure the page opens.

- The next question the thread asks within a minute shows. If it still has no working page, its card is marked **link missing**.
- If none comes in that minute, the original question comes back as Sotto's own card, marked link missing. Zach's answer goes to the thread as his message, quoting the question. A new question from the thread puts that card away.
- A question that only takes listed choices cannot carry the note (a Devin choice field). It shows at once, marked link missing, and nothing is sent.
- A thread is sent back once for each question it asks without a link. Its answer to the note is a new question, which is not sent back again.
- Building it settled the rest. The note answers a question with several parts in each part, and goes only when the provider confirms it took it; when the provider refuses it or cannot say, the question shows at once, marked link missing. A provider that has not confirmed within ten seconds cannot say; if it confirms later, Sotto still records that it answered, and the question stays where Zach sees it. The next question in the minute waits for its own pages too, whatever it asks. When a thread's snapshot carries only the summary of the reply before a question, and that summary is cut at its limit without saying prototype, the question waits while the search reads the whole reply from the thread's store, and the words it read decide. When the minute ends while the provider still waits on the original, the original shows, marked link missing, rather than a copy. A question still unsearched after 30 seconds shows as ADR-0085 showed it, and one still waiting on the provider's word about the note shows marked link missing, so neither a search nor a provider can keep it from Zach. Zach's answer to Sotto's copy joins the thread's follow-up queue, so it goes at once to a thread at rest and after the turn of a busy one. Sotto's copy is a Sotto request (ADR-0035) under `sotto:prototype-question:` and the original's ID. Watcher's own threads and settled or archived threads hold nothing. A hold is in memory on the host that runs the thread: a restart shows whatever the provider still waits on, and a remote host holds its own.

**Why this answers nothing on Zach's behalf.** ADR-0004 keeps every grant with the user, and nothing Sotto sends approves anything. Sending a question back gives no answer to what the agent asked: it says the user has not seen the question and asks the agent to ask again. It is never sent for a permission. The words are fixed and say who wrote them. Sotto sends them only when the question is about a prototype and Sotto found no working page for it, and only once for that question. The user still answers every question that reaches him, including Sotto's copy, and the agent hears his answer as his.

**Opening on the desktop.** Main opens a page in the browser **Web links in threads** chooses. In the system browser, a file opens as a file and an address as an address, as before. In Sotto's browser, an address opens as it is. A file opens through the phone access listener's loopback address under its token, because Sotto's browser opens no `file://` pages. With phone access off there is no listener, so the file opens in the system browser. Opening a page through main clears the mark when the page is one of its pages.

## Consequences

- A thread holding a prototype question shows no card for the few seconds the search takes, and none while it is sent back. ADR-0085 accepted that a card appears first without its pages. A prototype question now waits for them.
- Watcher and the Overview count a waiting prototype as needing Zach. Watcher can no longer say nothing needs him while one waits.
- Sotto checks a loopback address with one GET when a page is found, from the host that runs the thread. It contacts no new host.
- The iPhone does not show the held card, because the host holds it. It shows a link-missing question as an ordinary one and has no prototype-ready mark yet. Both are in a follow-up issue.
