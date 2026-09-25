# A thread uses Sotto's browser without asking, by default

## Status

Accepted September 25, 2026 (Zach, step 3 of `docs/plans/2026-09-25-agent-tool-exposure.md`, issue #332). Supersedes, for Sotto's own browser, ADR-0020's rule that opening a page, navigating, clicking and typing each wait for the user's one-time answer, and its September 22 amendment's page-opening grant.

## Context

Zach reported agents asking for permission every time they used Sotto's browser. Two questions stood in the way. The provider's own prompt is gone since #335 (ADR-0020, September 25 amendment). What remains is Sotto's own question in Tools, for every open, navigation, click and typed entry. The page-opening grant (#232) removed it for opens and navigations, but only after the user had answered once in each thread, only until Sotto closed, and never for clicks or typing. An agent testing an app clicks and types all the time, so the question came back at every step. T3 Code, which Zach compared Sotto against, starts its threads in full access and asks nothing.

AGENTS.md says the user answers every permission, and ADR-0004 keeps authority in records the user creates. A thread's permission mode already lets a provider act without asking, but the user picks that mode. A grant that exists before the user has said anything is not the user's answer. This decision is therefore an exception to that rule, made deliberately, not an interpretation of it.

## Decision

**A browser grant lets one thread open pages, navigate, click and type in Sotto's browser without asking.** It covers the four actions ADR-0020 held for an answer, and nothing else. It is shaped like an ADR-0004 policy record (action, resource, scope, effect, source, granted, expiry and revocation times) and held in the browser service's memory, like the page-opening grant it replaces.

**Every project thread has one by default.** **Let agents use the browser without asking** in Settings is on until the user turns it off. While it is on, a thread's grant has the source `settings`. While it is off, a thread asks as before, and a waiting request offers **Allow this thread to use the browser** beside Allow once; that answer creates a grant with the source `user`.

**The user can stop it for one thread.** **Stop** on the grant line in Tools > Browser ends that thread's grant, whichever its source. The thread then asks again until the user allows it again or Sotto restarts. Turning the setting off ends every settings grant at once; grants the user gave by answering stay until stopped.

**What does not change.** A page the user opened stays private until the user shares it. A page the agent opens is shared the way Open and share shares it, with the same revocation when a navigation leaves its origin. The endpoint still binds one thread, and a grant reaches no other thread. Supervision, memory, repetition and a provider's own confirmation still never create one. A waiting action whose page has changed still does not run. Pausing a task still stops its later actions. Grants still end when Sotto closes, when the thread is gone, and when the browser shuts down with its window.

## Consequences

- An agent in a project thread can click and type in any page it opens in Sotto's browser without asking first, including a page on a site where Sotto's browser is signed in. Settings and the guide say so plainly.
- AGENTS.md names this exception beside "The user answers every permission". A second standing grant of this kind is a new ADR, not an extension of this one.
- The user's controls are one setting for every thread and one Stop for each thread. A stopped thread asking again is visible in Tools > Browser, where its request waits.
- The page-opening grant's names give way to the browser grant's in code and in `CONTEXT.md`, because the old names would say "opening pages" about clicks and typing.
