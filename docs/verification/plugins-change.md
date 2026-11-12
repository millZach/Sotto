# A plugin change asks first

Checked on Windows on November 12, 2026, in the built app, for #2489: the fourth slice of
`docs/plans/2026-11-11-plugins.md`. A thread's agent can now ask to change something through a plugin, and the change
waits on a card in its thread until the user answers. ADR-0205's decision 7 and its November 12 note on how a change
waits record the decision.

gh was a stand-in (`tests/fixtures/fakeGhSignIn.mjs`) that reaches nothing: it says it is signed in as
`example-user`, and writes down what a `POST` handed it instead of sending it. The run is
`tests/e2e/plugins-change.spec.ts`, with the Owl feature turned on by `SOTTO_OWL_FEATURES=plugins=1`. The tool was
called through the end-to-end hook `pluginTool`, which calls the same tool server a provider's call reaches, for a
real Codex thread over the fake app server. Nothing reached GitHub.

## What was done

In the thread "Check the checkout page", `github_comment` was called for `example-owner/example-repo` #12 with a
two-line comment. The call did not return. The thread showed a card headed "Comment on GitHub as example-user" under
a GitHub tag, with `example-owner/example-repo #12` and both lines of the comment, and two buttons: **Post the
comment** and **Don't post it**. The thread moved to **Needs you**, and the reply box read "Queued until you answer
the card". The stand-in had been handed nothing.

The card was checked in dark at 1600x1000, 1280x800 and the 820x560 minimum, and in light at 1280x800. It stayed
inside its pane at each.

**Don't post it** was pressed. The card went, the call returned "The user said no. Nothing was changed. Do not ask
again unless they tell you to.", and the stand-in had still been handed nothing.

The tool was called again, and **Post the comment** was pressed from the keyboard, with focus on it and Enter. The
call returned "The user allowed it, and the comment is posted:" with the comment's address. The stand-in had been
handed one `POST` to `repos/example-owner/example-repo/issues/12/comments`, with the comment as JSON on standard
input and none of its words among the arguments.

Settings › Plugins then read "Reading never asks you. A change, such as posting a comment, asks you first in its
thread, each time." GitHub's **Recent use** listed, newest first: "Posted a comment in “Check the checkout page” You
allowed it." and "Asked to post a comment in “Check the checkout page” You said no." The comment's words were nowhere
on the page.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/plugins-change/comment-card-dark-1280x800.png` | The card waiting in its thread, dark |
| `artifacts/plugins-change/comment-card-light-1280x800.png` | The same in light |
| `artifacts/plugins-change/comment-card-dark-820x560.png` | The same at the 820x560 minimum |
| `artifacts/plugins-change/recent-use-changes-dark-1280x800.png` | Recent use after one no and one yes |

## What unit tests cover instead

`tests/unit/main/plugins/pluginChangeTools.test.ts` and `pendingChanges.test.ts` cover what this run does not: a
card that lapses, a thread deleted while its card waits, Watcher being listed the reading tools alone and refused a
change without asking, arguments turned away before anyone is asked, a gh that cannot post, and the Vercel cancel
against a stand-in `fetch`: the deployment read for its card, nothing but that read before the answer, the `PATCH`
after it, a build that had already finished, and the token kept out of everything said back.

## Not checked

- No real comment was posted and no real build was cancelled. Both wait for Zach: a comment on a test issue, and a
  cancel of a preview build on a project of his.
- The card on a paired phone. It is an ordinary permission request in the thread, which the phone apps already
  show, but it was not opened on one.
