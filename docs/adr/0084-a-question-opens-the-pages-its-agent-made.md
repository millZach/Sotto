# A question opens the pages its agent made

## Status

Accepted October 14, 2026. Zach asked that every question about a prototype carry a link he can open on the computer and on the iPhone, whatever the provider, after #954 left most of them without one. He chose the approach, the reach and the look from the questions and the prototype on the tag `prototype/question-prototype-pages` (variant A). Amends ADR-0033 and ADR-0050: the phone-access listener now serves one more route, a question's page, besides the host protocol. Builds on #954's message links, recorded in `docs/plans/question-choices.md`.

## Context

An agent that makes a prototype asks which variant the user wants. #954 brought the web links in the agent's message onto the question card and the iPhone's question sheet, but only `http` and `https` addresses. Of the prototype hand-offs in Zach's threads in the two weeks before this record, about a third were a tailnet link that opened on the phone. The rest were a `localhost` address, which the phone's row could not reach, or a file path such as `docs/prototypes/x.html` or a `file://` link, which got no row at all. Nothing told the providers how to hand a prototype over. Only Claude Code had a skill for it, and only when the skill triggered. Instructions alone would be the same kind of rule agents already skip.

## Decision

**Sotto finds the pages itself.** When a question first appears in a host's snapshot, the host's coordinator reads its words and the agent's newest reply in that thread at that moment. It looks for three kinds of page: an HTML file, named by path, `file://` link or file name; and a page the agent serves on that machine's loopback (`http://localhost:<port>/…`, `127.0.0.1`, `[::1]`). It does this for every provider, because it reads what the agent wrote, not what the provider sends. A question's pages are fixed when it is asked, so a reply the agent writes after asking, as Codex can, does not move them. Permissions get none.

**What counts as a page.** A file must be an `.html` or `.htm` file inside the thread's folder once links are followed, and outside `.git`. A path that is not where the agent said is looked for by its name in the folder, without hidden or dependency folders, and is used only when one file matches, or one matches more of the folders the agent wrote. Nothing outside the thread's folder is offered. A loopback page needs no folder. A question carries at most eight pages.

**Each page gets a token, and the host serves it.** A page found gets a 32-character random token, and the question carries `{ token, kind, name, start }` as `pages`. Providers never supply it: the coordinator puts its own pages on each question and removes any others. The token is good while the question waits and for an hour after it is answered or withdrawn. A restart makes new tokens, which the next snapshot carries.

**The listener serves `/page/<token>/<start>`.** The host's socket listener, the one phone access carries through Tailscale Serve on the desktop (ADR-0033) and on a headless host (ADR-0050), and the loopback listener a desktop reaches a host on, answers that path before its origin check. The token is the only thing that admits a request; no session, pairing or origin is asked for, because Safari on a phone holds none of them.

- A file page serves its own folder read-only, GET and HEAD only, and only the kinds of file a page is made of: pages, styles, scripts, JSON, images, fonts, audio, video and WebAssembly. Hidden files and anything outside the folder are refused, whatever the token. So is source code, which has none of those types.
- A loopback page passes GET and HEAD on to the address the agent named, never to the listener's own port. Only plain request headers go through, never cookies or Tailscale's own. The page server's cookies do not come back. A redirect within that server stays on the page's route. A page that loads files from its server's root, or needs a live-reload socket, may not load fully; the user accepted that.
- Every answer carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`. The page then runs as an origin of its own, not as the listener's, so its script cannot use the listener's routes. `Access-Control-Allow-Origin: *` lets that sandboxed page load its own files. `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `nosniff` are always on. A token nobody holds, a moved file and a stopped server each get a short page that says what happened, that nothing was lost and what to do next.
- Page requests share one budget of 1,200 a minute.

**Where each client opens a page.**
- *The desktop* opens a page through main, by the request it is on and its token, never by path or address. The router checks that the host put that token on that request. A file on this computer opens in the default browser as the file, a loopback page at its own address, and a remote host's page at that host's tailnet address, or its SSH forward, under the token.
- *The iPhone* opens `https://<computer>.ts.net:<port>/page/<token>/<start>` in Safari's in-app browser over the question sheet. It uses the address its connection reached, which can be phone access's other port, and needs Tailscale on the phone as phone access already does.
- *On both*, a page is an **Open the prototype** row named by its file or address, before the message's **Open the link** rows. A loopback link that is one of the question's pages has no row of its own. A row opens and picks nothing, and works while the choices cannot be used. Android shows no link rows yet and gets none of this.

## Consequences

- The privacy line moves, and the README says so. What a paired phone could read already included a thread's files through Tools. Now anyone holding a page's token can read that page's folder of web files, and the loopback page it names, over the tailnet, for as long as the token lives. The token reaches only the clients that are sent the thread's questions, which are the paired phones and desktops. No new host is contacted.
- A question appears without pages for the moment the host takes to find them, then with them. A client that compares a waiting request before it answers leaves pages out of the comparison, so the answer still goes. The iPhone does this; the desktop answers by the request's ID and questions.
- Agents need not be told anything, and are not. A prototype hand-off is only as good as the path or address the agent writes, and one the host cannot find stays a plain message.
