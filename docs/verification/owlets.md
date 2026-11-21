# Owlets, the first slice

ADR-0213's first slice in the running apps: the desktop's Owlets page (#2742) and the iPhone's Owlets tab (this pull request), checked on November 21, 2026. Owlets are an Owl feature, so every run here is on the Owl track.

## The desktop

`tests/e2e/owlets.spec.ts` on forge (Omarchy, xvfb at 1920x1200, the pinned Node 24.22.1), run against a fresh `npm run build` of this branch with `SOTTO_E2E_EVIDENCE=publish`. It passed in 4.7 s. It makes Tawny from New owlet, opens her thread, talks to her through Sotto's fake Claude Code, makes Scops on Codex, renames him with Edit owlet, checks that Claude Code was launched with its memory off and Tawny's name and role in its instructions, and checks that neither owlet shows on the Threads page.

That spec, and every other spec that runs Sotto's fake Claude Code or Codex, can't start the fake on `main` today: since the engine moved into a chunk, it looks for `tests/fixtures` one folder short (#2767). The run here used that issue's workaround, a link from `out/tests` to `../tests` made for the run and removed after it. Without it, `claude-steer.spec.ts` fails the same way on the same build, so the failure is not this branch's.

| Screenshot | What it shows |
| --- | --- |
| [empty-dark-1280](../../artifacts/owlets/empty-dark-1280.png) | The page before any owlet: what an owlet is, and New owlet. |
| [setup-dark-1280](../../artifacts/owlets/setup-dark-1280.png) | New owlet: name, role, home computer, a Claude Code or Codex model, permission mode, the folder it makes and the plugin accounts line. |
| [page-dark-1280](../../artifacts/owlets/page-dark-1280.png) | Two owlets in the sidebar (R2 rows) and Scops's thread, with its role, home computer and `Owlets/Scops` over the composer. |
| [talking-dark-1280](../../artifacts/owlets/talking-dark-1280.png) | Tawny answering in her thread. |
| [needs-dark-1280](../../artifacts/owlets/needs-dark-1280.png) | Tawny asking for a permission: she leads the sidebar under Needs you, and the card waits in her thread. |
| [page-light-1280](../../artifacts/owlets/page-light-1280.png) | The same in light. |
| [page-dark-820](../../artifacts/owlets/page-dark-820.png) | At the 820x560 minimum, with the sidebar on its rail. Nothing clips. |
| [page-dark-1600-reduced-motion](../../artifacts/owlets/page-dark-1600-reduced-motion.png) | At 1600x1000 with reduced motion. |
| [threads-dark-1600](../../artifacts/owlets/threads-dark-1600.png) | The Threads page with neither owlet on it. |

## The iPhone

On GitHub's macOS runners, from the throwaway branch `duo-captures/owlets-iphone` (runs 44930941371 and 44934108194, Xcode 26.6 for the phones and 27.1 for the Duo), which carried this branch's commits and ran only these tests. The UI fixture's laptop makes owlets and keeps four (`--ui-owlets`): Tawny asks to send an email, Scops finished while nothing showed it, Elf ran yesterday and Barn never ran.

`FocusJourneyTests.testTheOwletsTabListsOwletsEditsOneAndMakesOne` passed on the small iPhone (iPhone SE, 3rd generation) and the large one (iPhone 16 Pro Max at accessibility-large text with Reduce Motion), which is how CI runs every journey. It checks that the tab stands after Threads and before Computers, that Threads lists no owlet, that Tawny leads under Needs you, that her thread shows her role and her folder, that her ••• has Edit owlet, which opens on her name and asks for no model, and that New owlet makes Kestrel and opens Kestrel's thread.

| Screenshot | What it shows |
| --- | --- |
| [small-owlets-list](../../artifacts/owlets-iphone/small-owlets-list.png) | The Owlets tab after Threads, with its badge: Tawny under Needs you, then the rest newest first, each with its own mark. |
| [small-owlets-thread](../../artifacts/owlets-iphone/small-owlets-thread.png) | Tawny's thread: her name and role, `Claude Code · Owlets/Tawny · Laptop`, and her permission waiting. |
| [small-owlets-menu](../../artifacts/owlets-iphone/small-owlets-menu.png) | Edit owlet at the top of her ••• menu (Zach's pick A). |
| [small-owlets-edit](../../artifacts/owlets-iphone/small-owlets-edit.png) | Edit owlet: her name and role, and the line that her model and permission mode change in her thread. |
| [small-owlets-new](../../artifacts/owlets-iphone/small-owlets-new.png) | New owlet with a name and role typed. |
| [small-owlets-made](../../artifacts/owlets-iphone/small-owlets-made.png) | Kestrel's thread, opened once Kestrel was made. |
| [large-owlets-list](../../artifacts/owlets-iphone/large-owlets-list.png) | The tab at accessibility-large text. |
| [large-owlets-thread](../../artifacts/owlets-iphone/large-owlets-thread.png) | An owlet's thread at that size. |
| [large-owlets-new](../../artifacts/owlets-iphone/large-owlets-new.png) | New owlet at that size. |

The Duo captures (`DuoCaptureTests.testOwlets`, through `apps/ios/Scripts/duo-captures.sh`) ran folded, sideways and upright:

| Screenshot | What it shows |
| --- | --- |
| [duo-folded-owlets-dark](../../artifacts/owlets-iphone/duo-folded-owlets-dark.png) | Folded: the tab in the strip's rail, after Threads and before Watcher, and the rail's + for New owlet. |
| [duo-folded-owlet-thread-dark](../../artifacts/owlets-iphone/duo-folded-owlet-thread-dark.png) | Folded: Scops's thread, its controls in the strip. |
| [duo-sideways-owlet-thread-dark](../../artifacts/owlets-iphone/duo-sideways-owlet-thread-dark.png) | Sideways: the owlets beside Scops's thread (Zach's pick A), and no Watch on the thread's pill. |
| [duo-sideways-owlets-light](../../artifacts/owlets-iphone/duo-sideways-owlets-light.png) | Sideways, the tab in light. |
| [duo-upright-owlet-sidebar-dark](../../artifacts/owlets-iphone/duo-upright-owlet-sidebar-dark.png) | Upright: the owlets drawn over Scops's thread from the rail's sidebar button, with New owlet in their heading. |
| [duo-upright-owlets-light](../../artifacts/owlets-iphone/duo-upright-owlets-light.png) | Upright, the tab in light. |

The first Duo captures showed Watch on an owlet's thread pill, which ADR-0213 rules out. The iPhone now offers Watch on no owlet (`ThreadGroups.offersWatch`, with a test in `OwletsTests`), and the second run's captures above show it gone.

## Not checked here

- A real iPhone paired with a real computer making an owlet, and a real Claude Code or Codex account. The journeys use the UI fixture, and the desktop spec uses Sotto's fake clients.
- At accessibility-large text, an owlet's role wraps beside its name on the large iPhone's list rather than under it ([large-owlets-list](../../artifacts/owlets-iphone/large-owlets-list.png)). Everything stays on screen and readable.
- Windows and macOS desktop runs. The desktop spec ran on Linux only.
