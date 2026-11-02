# Favorite models lead the model menu

## Status

Accepted October 26, 2026, at Drake's request. It is an Owl feature (`model-favorites`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), Drake's call. No mock-up: it adds an affordance to the model menu, which already exists. It keeps the menu's fixed height (#1596) and changes nothing on Settings › Providers' model list (#1601), which Drake chose to leave without stars.

## Context

The model menu lists models by provider, and OpenCode's and Cursor's by model source or model maker under that (ADR-0087, ADR-0128). Someone who uses a handful of models from several providers walks the rail and a source list every time, and a model three levels down under OpenCode costs three presses to reach. The menu had no way to keep the few the user actually picks close at hand.

## Decision

**1. Favorites is the first tile on the rail.** A star tile above the first provider, named Favorites, shows every model the user starred, from every provider and model source, in the order they were starred. Each row carries its provider's mark before the name and its model source after it, so two GLM 5.3 rows from OpenCode Zen and Refuseless read apart. Choosing a row calls the same change a row in its provider's own pane does, so effort, permission mode and ADR-0089's start-a-new-thread all follow exactly as they would there; where a favorite's provider would start a new thread, the pane's foot says so in the menu's usual words. The tile shows only when the menu has a rail: a thread that can change only within its own provider has no Favorites.

**2. A star on every model row stars it.** The star ends each row in every pane, OpenCode's and Cursor's source lists and search results included. It shows on the row under the pointer or focus, and always where it is filled. A press on it stars the model or takes the star off and chooses nothing; F on a focused row does the same, and the row says so through `aria-keyshortcuts`. The star is hidden from the row's accessible name, so a row is still called by its model's name.

**3. Favorites belong to this computer's window, not to a thread or a host.** They live in the renderer's `localStorage` under `sotto.threads.modelFavorites`, the way the steps fold remembers itself (`stepsOpen.ts`), and survive a restart. Each entry is keyed by its provider and the provider's own model id, which already names an OpenCode model's source, and keeps the model's name, provider and source so it can still be shown while its provider is away. They are not a setting: nothing in main reads them, they are not synced to a host or a phone, and Settings has no switch for them.

**4. The menu opens on Favorites while any exist.** It opens there with the current model marked chosen when it is a favorite; with none, it opens on the current model's provider as before, and the Favorites tile holds one line: "Star a model to keep it here." Typing on Favorites searches every provider's models, under each provider's name, not only the favorites. Escape clears that search first, then closes the menu.

**5. A favorite that cannot be chosen stays listed.** A menu lists only the favorites of providers it offers, so one that offers some providers, such as continuing a thread or a worker role's, leaves the others out rather than calling them unavailable, and opens on Favorites only when it lists one. Within that, one whose provider is turned on but not connected, or whose model the provider no longer lists, reads Unavailable the way an unready model does, and choosing it does nothing. Unlike an unavailable row elsewhere it can still take focus, so its star can come off from the keyboard; taking a star off on Favorites moves focus to the row that takes its place.

## Consequences

- Stable shows no tile and no stars, and keeps any favorites an Owl build saved; turning the feature on brings them back as they were.
- Favorites do not follow the user to another computer or to the iPhone. If that is wanted, they become a setting in main, which is a new decision.
- A favorite's name is the one it had when starred while its provider is away; once the provider lists it again, the row shows the provider's current name.

## November 1, 2026: the iPhone stars its own

The iPhone's reply box now opens a settings sheet whose Favorites come after the model in use ([ADR-0166](0166-the-iphones-reply-box-changes-what-a-thread-runs-with.md), November 1, 2026). Carrying this window's favorites to the phone would have made them a setting in main, the new decision the Consequences name. Zach chose instead to let the phone star its own: a star after every model row in the sheet, kept in the iPhone's preferences in the order starred, keyed as decision 3 keys them, and never sent to a computer, as this window's are never sent to the phone. They are not held for Owl: the iPhone sheet is a fix to a stable surface, so its stars ship with it. A phone favorite the sheet doesn't offer, another provider's in a thread's sheet or a model its computer no longer lists, is left out rather than shown unavailable, and comes back when a sheet offers it again.
