# Browser profiles keep the user's sign-ins

Proposed on November 27, 2026, for Zach's review. Rez asked that Sotto's browser do everything T3 Code's does ([ADR-0220](0220-sottos-browser-does-what-t3-codes-does.md)). T3 Code's browser keeps sign-ins in profiles: a default profile that keeps them, an incognito one that does not, profiles the user names, and an import wizard that copies another browser's cookies into a new profile. Sotto's browser kept nothing: every page lived in an in-memory session for its working copy, gone when Sotto quit, so a site the user signed in to asked again the next day. Rez's rule shapes the rest: importing another browser's cookies or using a signed-in profile must be the user's action, never an agent's. Part of the `browser-parity` Owl feature (ADR-0072).

No mock-up round was held. The direction is settled by Rez's request and rule, and the profiles sit on a surface that exists: the empty pane, with the servers and **Opened this session**, and a chip beside the address like the one that names a host's machine. They were checked in the built app in light, dark and reduced motion at 1600x1000, 1280x800 and 820x560.

A **browser profile** is defined in `CONTEXT.md`.

## Decisions

1. **The user chooses where new pages open.** With no page open, the pane offers **Open new pages in**: **A fresh page**, which keeps nothing after Sotto closes, as every page did before, or one of the user's profiles, which keeps sign-ins. A page opens in what is chosen when the user opens it, by its address, a server or an address opened this session. The page then says which profile beside its address.
2. **No agent reaches a profile.** No agent tool takes a profile, and `browser_open` refuses one in words. An agent's own pages open in the thread's session, which keeps nothing. A page the user opens in a profile starts private even under the browser grant (ADR-0029), says "This page is private. The agent cannot see it", and the agent sees it, as any page, only once the user presses **Share with agent**. The profile's name is never listed to an agent.
3. **Where a profile lives.** Names and IDs are in `browser-profiles.json` in Sotto's data folder, the user's alone (0600), changed only by the pane. Each profile's cookies and site data are Electron's persistent partition `persist:sotto-profile-<id>`, under `Partitions/` in Sotto's data folder, held to the same rules as every page's session: no permission prompts granted, no downloads, no file or custom-scheme navigation. A profile is the user's across threads and projects. At most 24, each named once.
4. **Copying sign-ins is one press, once.** **Add a profile that keeps sign-ins** takes a name and, when Firefox or Zen keep a profile on this computer, **Copy sign-ins from** with that profile's name. Sotto copies the profile's `cookies.sqlite` to a folder of its own, reads it with Node's `node:sqlite`, sets each cookie in the new profile's session, and deletes the copy. It skips expired cookies, partitioned ones and those in Firefox's containers, and turns SameSite=None without Secure, which Chromium refuses, into the browser's default. The other browser's files are only read. The pane says how many cookies were copied; a profile whose copy failed is not added, and the words say to close that browser and try again. Later sign-ins in either browser stay separate. Finding the profiles reads `profiles.ini` in Firefox's and Zen's usual folders on Windows, macOS and Linux (with Snap and Flatpak's on Linux); the window learns their names, never their folders. Under test, Sotto looks only in the test's own folder.
5. **Chromium browsers and Safari are not copied from.** On Windows their cookies are sealed with app-bound encryption only the browser can open. On macOS and Linux they need the browser's key from the Keychain or the Secret Service, and Safari's need Full Disk Access; those paths decrypt the user's credentials and could not be verified on the computer this was built on. They are a later decision, with a test on each platform.
6. **Removing a profile deletes it.** **Remove** asks in place, **Delete sign-ins** or **Keep**, with Keep focused. Deleting closes the profile's pages, clears its cookies and site data, and removes it from the list; the partition's folder, which Chromium may hold open while Sotto runs, is deleted at the next start.
7. **This computer's only.** A paired host's thread browses in the host's Chromium with a temporary profile (ADR-0198); the pane offers no profiles there and the test iPhone keeps its own storage, so neither opens in one.
8. **Nothing is contacted or logged.** Copying reads local files and writes Chromium's cookie store; no value is logged, shown or kept anywhere else. No dependency is added. Windows first, then Apple silicon macOS and Linux alike. The README's privacy section says what a profile keeps.

## Considered options

- **Keep the in-memory session and add nothing.** Sign-ins are what makes testing a signed-in app possible; T3 Code keeps them, and its users asked.
- **Let an agent pick a profile, as T3 Code's `preview_open` does.** Rez's rule rules it out: the agent would act as the user on every site the profile is signed in to.
- **Share a profile's pages under the grant like any page.** The grant was made for pages that keep nothing (ADR-0029); a signed-in page carries the user's accounts, so it waits for the user's own **Share with agent**.
- **Copy Chromium's cookies through PowerShell's DPAPI on Windows.** It reaches only cookies from before app-bound encryption, and Chrome, Edge and Brave no longer write them.

## Consequences

A user signs in once and stays signed in across runs, in a profile they chose, and can bring their Firefox or Zen sign-ins. An agent never holds a signed-in page the user did not hand it. Chromium and Safari users sign in again in Sotto's profile until decision 5 is revisited.

## November 27 amendment: a shared profile page stays on its site

A review found that a page in a profile, once the user shared it, followed the thread's browser grant to any site, as a fresh page does (ADR-0029, October 5 amendment). A signed-in page is the user's accounts, so it now keeps to what the user handed over.

- **Sharing stays with the site the user shared.** When a shared page in a profile goes to another origin, by a link, a redirect or the page's own script, it becomes private again, grant or not, and says so with **Share with agent**.
- **An agent's navigate to another site asks every time.** "Take this page, signed in with your Work profile, to another site and share it there" asks the user even under the grant, with **Allow once** alone; **Allow this thread** is not offered, and a request to allow it for the thread is refused. Allowed, the page is shared at the new site.
- **Downloads ask.** Decision 3's "no downloads" holds while the full catalog is off. With it on, a profile page's download waits for the user to place it, as every page's does ([ADR-0222](0222-the-browser-zooms-downloads-shows-the-agents-cursor-and-takes-drawings.md), decision 3).

## November 27 amendment: a list Sotto cannot read is kept as it is

The owner's review found that a profiles file Sotto failed to read counted as no profiles, so the sweep at the next start deleted every profile's sign-ins and the next Add wrote over the file.

- **Only a missing file is no profiles.** A `browser-profiles.json` that fails to read, is not JSON, or is not the version-1 file this Sotto writes (a newer Sotto's, or one damaged) is trusted for nothing but showing what it can: each entry that is a whole profile is still listed, so its pages open. While that lasts, Sotto adds and removes no profile, refusing in words before a removal closes a page or deletes any data, and the sweep at start deletes no partition, since a profile it cannot read is still the user's. Remove takes the profile off the list before it deletes the profile's cookies and site data, so a list that fails to change as it is written keeps the sign-ins; data left behind goes with the next start's sweep. A failed read is tried again next time rather than remembered. The file keeps its strict version-1 shape, as Sotto's other files do; the tolerant read is for showing only.
