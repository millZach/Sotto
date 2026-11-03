# Renderer broadcast subscription audit

Audited against `a05048246` on 2026-11-03, following the unrelated-broadcast defect found in PR #2043. This is a source audit with focused regression counts, not an app-wide performance measurement.

## Scope and mechanisms

The inventory covers **138 static subscription registrations**: 80 `useSyncExternalStore` registrations, 57 direct preload/domain bridge registrations, and Watcher's room adapter registration. It also follows **37 direct agent-context consumer sites**, since React context can bypass an otherwise stable external-store snapshot. Counts are source registrations, not mounted component instances; the bridge wrapper and its consumer are counted separately. The fix adds one imperative browser-task observer in place of its former global React task-hook consumption.

- **Electron channels.** `src/preload/index.ts`'s `subscribe` validates the channel payload, calls that channel's listener, and removes it idempotently. `createBufferedSubscription` validates once, queues a bounded number while there are no listeners, and drains on registration. There is no universal renderer IPC bus: settings, dictation commands, recovery, speech, updates, browser, terminals and agent state have separate channels.
- **Agent context.** `agents/agentStateCatalogs.ts` reconstructs wire deltas and retains omitted catalogs; `agents/stateSharing.ts` retains equal nested state. `AgentContext.tsx` applies thread details, coalesces visible shell updates by animation frame and catches up after hiding. A changed root context still renders direct `useAgents`/`useOptionalAgents` consumers. Memo dependencies must follow the relevant slice to avoid expensive work on those renders.
- **Watcher room context.** `shared/watcherRoomChanges.ts` reconstructs room deltas; `watcherRoom.tsx` rejects older snapshots and keeps watched-thread/action contexts separate. Unchanged watched IDs retain their set identity.
- **Renderer stores.** Listener sets often notify globally. `useSyncExternalStore` is safe when its snapshot keeps the same reference or primitive for an unrelated change. Drafts, files, browser pages, terminal sessions, requests and subagents generally do this already; delegations/subagents/turn browser lines/pace also narrow listener delivery.
- **Other signals.** Storage/custom preference events, media queries, root-theme mutation observers and Lingui changes carry cached preference snapshots or primitives. Terminal output writes directly to the matching native terminal view. Window visibility/resizing, audio device/track changes and input listeners are local lifecycle/input signals, outside this broadcast inventory and its 138 count.

The implementation bodies, callback bodies, snapshot readers and consuming calculations were read; search/AST enumeration supplied the checklist rather than the conclusion.

## Proven offenders fixed

| Offender | Before | Fix and evidence |
| --- | --- | --- |
| Browser task list | Every task replaced the global list. Nine hook consumers used that list even though eight only display one thread; the ninth auto-open observer caused Tools to render even when auto-opening was disabled. | `useThreadBrowserTasks` retains a thread's ordered task references until they change. Eight display callsites use it. `useBrowserOpensItself` observes imperatively, still marking all task IDs as seen so changing focus cannot reopen an old task. `browserPane.test.tsx` measured **1 Tools commit before / 0 after** one foreign task, on both quiet and classic browser; own-thread updates still render. `browserTaskSubscriptions.test.tsx` checks 20 unrelated updates produce 0 renders, own changes produce 1, global task-limit eviction still updates, and focus changes/unmount preserve auto-open behavior. |
| Usage source filter | In Sotto/Outside Sotto created a new `[where]` each render. Unrelated agent-context broadcasts invalidated `read`'s source dependency, rerunning host scoping and summary presentation over unchanged usage data. | Memoise `sources` by `activityFilters` and `where`. `usageBroadcasts.test.tsx` measured **10 host-scoping calls before / 0 after** 10 unrelated agent updates for each filter; after the fix presentation is also 0 and no read is requested. Changing the actual filter still recomputes and requests its data. |

Browser display callsites: `BrowserPane`, `ClassicBrowserSurface`, `IPhoneSurface`, `BrowserPlayer`, `PhonePlayer`, `ToolsToggle`, and `ToolsPanel`'s live-surface and floating-browser eligibility reads. They retain existing page/device filters and task ordering. The task slice follows the existing bounded global list, including its eviction behavior, rather than retaining tasks indefinitely.

PR #2043's `CouncilChamber` defect is already fixed at the audited commit: `heldThreads` returns its previous map when the selected seat-thread references match, and `scene` depends on that retained map. The component still receives context renders; unrelated threads do not invalidate its scene memo. No second patch was made there.

## Candidates left unchanged

These need a narrower-input trace and/or a mounted count fixture before a safe fix is justified. They are not claimed to be proven redraw defects comparable to the two fixed above.

- Provider/worker settings consumers derive picker choices from broad agent state. Those inputs include connection, configuration and capability state, so narrowing needs a count fixture and dependency trace. Council's broad catalog memo was also checked: `newThreadDefaultsCatalog` selects an existing model-array reference, and `useSeatsInForce` additionally retains seats by their semantic key. No additional expensive Council redraw was demonstrated.
- `watcher/watcherRoom.tsx` rebuilds its thread-address index when the thread list changes. Its public watched-thread set already stays stable through the encoded watched key. Measure the index work and prove address-only dependencies before changing it.
- `watcher/checkQueues.ts` exposes the full queue view, and `watcher/MoveThreads.tsx` exposes the full move view to both card/proposal hooks. Per-thread selectors may help, but queue eligibility and move state can depend on other machines/threads; no mounted count test here proves a particular update irrelevant.
- `agents/bringChangesBack.logic.ts` and `features/settings/HostClientUpdates.tsx` deliberately publish global manual dismissal/acknowledgement revisions. Cross-row invalidation is directly visible, but the relevant action/parent/host scope and user-visible cost were not established. Leave those low-frequency interactions intact.
- `watcher/watcherFirstMessage.ts` publishes the shared first-message record while it is being composed; some delivery consumers may only need its phase. No unrelated surface computation was demonstrated.
- Broad AgentContext/AppContext reads remain. Isolating every context consumer would be an architectural change; this patch only prevents calculations/renders with measured irrelevant inputs. Settings, theme, locale, window and update changes intentionally affect several surfaces.

## External-store subscriber inventory (80)

Line references below are to the patched tree. A stable snapshot can avoid React work even when its listener is called. Full-domain readers are distinguished from the per-thread/primitive readers rather than assumed to be defects.

| Subscriber | Registrations | Relevance / snapshot |
| --- | ---: | --- |
| [agents/MarkupEditor.tsx:69](../../src/renderer/src/agents/MarkupEditor.tsx#L69): `LiveLayer` (69) | 1 | Its own live markup snapshot. |
| [agents/ServerMark.tsx:239](../../src/renderer/src/agents/ServerMark.tsx#L239): `usePaceValue` (239) | 1 | Per-turn listener and primitive pace. |
| [agents/ThreadActivity.tsx:616](../../src/renderer/src/agents/ThreadActivity.tsx#L616): `useTurnBrowserLines` (616) | 1 | Per-turn listeners and cached browser lines. |
| [agents/ThreadCompaction.tsx:61](../../src/renderer/src/agents/ThreadCompaction.tsx#L61): `ThreadCompaction` (61) | 1 | Boolean for this snapshot. |
| [agents/ThreadComposer.tsx:666](../../src/renderer/src/agents/ThreadComposer.tsx#L666): `useComposerControls` (666) | 1 | Cached semantic composer controls. |
| [agents/ThreadFollowups.tsx:64](../../src/renderer/src/agents/ThreadFollowups.tsx#L64): `useShortWindow` (64) | 1 | Window-size boolean. |
| [agents/ThreadPane.tsx:287](../../src/renderer/src/agents/ThreadPane.tsx#L287): `ThreadPane` (287), `ThreadPane` (359) | 2 | Own draft-content boolean and relevant request-answer boolean. |
| [agents/ThreadSidebar.tsx:301](../../src/renderer/src/agents/ThreadSidebar.tsx#L301): `useFolderToggles` (301) | 1 | Cached folder-toggle storage value. |
| [agents/activityBodies.ts:131](../../src/renderer/src/agents/activityBodies.ts#L131): `useActivityBodies` (131) | 1 | Selected body keys encoded as a stable primitive. |
| [agents/bringChangesBack.logic.ts:47](../../src/renderer/src/agents/bringChangesBack.logic.ts#L47): `useBringBackDismissals` (47) | 1 | Global dismissal revision; deferred below. |
| [agents/continuations.ts:64](../../src/renderer/src/agents/continuations.ts#L64): `useContinueChoice` (64) | 1 | Own thread entry. |
| [agents/delegations.ts:108](../../src/renderer/src/agents/delegations.ts#L108): `useDelegations` (108), `useDelegationsOf` (140) | 2 | Thread-keyed listeners; combined view retains identity when entries match. |
| [agents/draftThreads.ts:145](../../src/renderer/src/agents/draftThreads.ts#L145): `useDraftThreads` (145) | 1 | The draft-thread list is the domain this view shows. |
| [agents/modelFavorites.ts:43](../../src/renderer/src/agents/modelFavorites.ts#L43): `useModelFavorites` (43) | 1 | Cached storage value. |
| [agents/nextPrompts.ts:60](../../src/renderer/src/agents/nextPrompts.ts#L60): `useNextPrompt` (60) | 1 | Own thread entry. |
| [agents/pendingSettings.ts:291](../../src/renderer/src/agents/pendingSettings.ts#L291): `usePendingSettings` (291) | 1 | Own cached thread view. |
| [agents/requests/RequestDraftRecovery.tsx:80](../../src/renderer/src/agents/requests/RequestDraftRecovery.tsx#L80): `useRequestDraftRecovery` (80) | 1 | Relevant owner/recovery snapshot. |
| [agents/requests/requestAnswers.ts:559](../../src/renderer/src/agents/requests/requestAnswers.ts#L559): `useRequestEntry` (559) | 1 | Own owner/request entry. |
| [agents/reviewComments.ts:162](../../src/renderer/src/agents/reviewComments.ts#L162): `useReviewDraft` (162) | 1 | Own thread draft array. |
| [agents/settleUndo.ts:108](../../src/renderer/src/agents/settleUndo.ts#L108): `useSettleOffer` (108) | 1 | The shared current undo offer. |
| [agents/sidebarSize.ts:38](../../src/renderer/src/agents/sidebarSize.ts#L38): `useSidebarSize` (38), `useSidebarSize` (39) | 2 | Width primitives. |
| [agents/splitLayout.ts:363](../../src/renderer/src/agents/splitLayout.ts#L363): `useSplitLayout` (363) | 1 | The shared layout. |
| [agents/stepsOpen.ts:25](../../src/renderer/src/agents/stepsOpen.ts#L25): `useStepsOpen` (25) | 1 | Shared steps preference boolean. |
| [agents/threadDraftStore.ts:753](../../src/renderer/src/agents/threadDraftStore.ts#L753): `useThreadComposer` (753), `useScreenshotReads` (757), `useSubmissions` (775) | 3 | Cached per-thread drafts/screenshots; submissions hook intentionally reads all submissions. |
| [agents/threadFacts.ts:338](../../src/renderer/src/agents/threadFacts.ts#L338): `useWordsRevision` (338) | 1 | Language revision only. |
| [agents/threadListStore.ts:51](../../src/renderer/src/agents/threadListStore.ts#L51): `useThreadList` (51) | 1 | Own thread list snapshot. |
| [agents/threadSnooze.tsx:49](../../src/renderer/src/agents/threadSnooze.tsx#L49): `useThreadSnoozes` (49) | 1 | Cached snooze storage value. |
| [agents/tipsSetAside.ts:73](../../src/renderer/src/agents/tipsSetAside.ts#L73): `useTipsSetAside` (73) | 1 | The shared set of tips put away. |
| [agents/unsentThreads.ts:53](../../src/renderer/src/agents/unsentThreads.ts#L53): `useListedRows` (53) | 1 | Encoded IDs/titles of relevant unsent rows; memoised list. |
| [agents/visualPageSlots.ts:84](../../src/renderer/src/agents/visualPageSlots.ts#L84): `useVisualPageSlot` (84) | 1 | Selected slot state primitive; global eviction is relevant. |
| [audio/liveLevel.ts:32](../../src/renderer/src/audio/liveLevel.ts#L32): `useLiveLevel` (32) | 1 | Isolated live microphone level. |
| [components/useThemeBrand.ts:112](../../src/renderer/src/components/useThemeBrand.ts#L112): `useThemeBrand` (112) | 1 | Brand-key comparison retains snapshot through unrelated root attributes. |
| [features/performance/useMainActivity.ts:57](../../src/renderer/src/features/performance/useMainActivity.ts#L57): `useAttachedRecording` (57) | 1 | Current attached recording name. |
| [features/settings/HostClientUpdates.tsx:42](../../src/renderer/src/features/settings/HostClientUpdates.tsx#L42): `useAcknowledgedRevision` (42) | 1 | Global acknowledgement revision; deferred below. |
| [features/settings/HostsModal.tsx:9](../../src/renderer/src/features/settings/HostsModal.tsx#L9): `useSyncExternalStore` (9) | 1 | Any-modal-open boolean. |
| [features/settings/hostQuestionDismissals.ts:38](../../src/renderer/src/features/settings/hostQuestionDismissals.ts#L38): `useHostQuestionDismissals` (38) | 1 | Cached dismissal set for host questions. |
| [features/settings/themes/themeEditorSession.ts:55](../../src/renderer/src/features/settings/themes/themeEditorSession.ts#L55): `useThemeEditorSession` (55) | 1 | Shared current editor session. |
| [state/appearance.ts:441](../../src/renderer/src/state/appearance.ts#L441): `useAppearancePreviewVersion` (441) | 1 | Global appearance preview revision; all preview consumers need it. |
| [state/interfaceLanguage.ts:115](../../src/renderer/src/state/interfaceLanguage.ts#L115): `useInterfaceLanguageState` (115) | 1 | Cached language state. |
| [state/interfaceLanguageReact.tsx:24](../../src/renderer/src/state/interfaceLanguageReact.tsx#L24): `useLingui` (24) | 1 | Cached Lingui context replaced only on language change. |
| [tools/FilesSurface.tsx:12](../../src/renderer/src/tools/FilesSurface.tsx#L12): `useThreadFiles` (12) | 1 | Own thread file-browser snapshot. |
| [tools/TerminalSurface.tsx:107](../../src/renderer/src/tools/TerminalSurface.tsx#L107): `TerminalSurface` (107), `TerminalScreen` (225), `TerminalScreen` (226) | 3 | Global session capacity is relevant; replay/error snapshots are per session. |
| [tools/babysitEndingsDismissed.ts:72](../../src/renderer/src/tools/babysitEndingsDismissed.ts#L72): `useBabysitEndingsDismissed` (72) | 1 | Cached shared dismissal storage value. |
| [tools/browserPlayerStore.ts:127](../../src/renderer/src/tools/browserPlayerStore.ts#L127): `useBrowserPlayerVisibility` (127), `useBrowserPlayerRect` (132) | 2 | Own visibility primitive and shared player rectangle. |
| [tools/browserStore.ts:491](../../src/renderer/src/tools/browserStore.ts#L491): `useThreadBrowser` (491), `useOpenedAddresses` (496), `useThreadBrowserTasks` (514) | 3 | Own browser/address snapshots; global task snapshot was the offender, now thread-scoped. |
| [tools/changesStore.ts:365](../../src/renderer/src/tools/changesStore.ts#L365): `useThreadChanges` (365), `useChangesView` (369) | 2 | Own cached thread status; global changes view intentionally shows the complete diff. |
| [tools/cloudIphoneStore.ts:141](../../src/renderer/src/tools/cloudIphoneStore.ts#L141): `useCloudSession` (141), `useCloudStatus` (146) | 2 | Own latest session reference and separate global service status. |
| [tools/paneTerminalStore.ts:113](../../src/renderer/src/tools/paneTerminalStore.ts#L113): `usePaneTerminalChrome` (113) | 1 | Own thread chrome. |
| [tools/phonePlayerStore.ts:124](../../src/renderer/src/tools/phonePlayerStore.ts#L124): `usePhonePlayerOpen` (124), `usePhonePlacement` (128) | 2 | Own open boolean and shared placement. |
| [tools/subagentsStore.ts:135](../../src/renderer/src/tools/subagentsStore.ts#L135): `useThreadSubagents` (135) | 1 | Thread-keyed listeners and cached thread view. |
| [tools/terminalStore.ts:473](../../src/renderer/src/tools/terminalStore.ts#L473): `useThreadTerminals` (473) | 1 | Own thread terminal snapshot; terminal bytes bypass React. |
| [tools/toolsPanelStore.ts:170](../../src/renderer/src/tools/toolsPanelStore.ts#L170): `useToolsPanelChrome` (170) | 1 | Shared Tools chrome. |
| [watcher/MoveSuggestion.tsx:42](../../src/renderer/src/watcher/MoveSuggestion.tsx#L42): `WatcherMoveSuggestion` (42), `WatcherMoveSuggestion` (58) | 2 | Shared current move sheet and current suggestion dismissal. |
| [watcher/MoveThreads.tsx:78](../../src/renderer/src/watcher/MoveThreads.tsx#L78): `useMoveMachines` (78), `MoveThreadsSheetHost` (230), `MoveThreadsSheet` (241), `useMoveCards` (400), `useMoveProposals` (408) | 5 | Shared machines/sheet; cards and proposals share a full view, deferred below. |
| [watcher/WatcherAsks.tsx:110](../../src/renderer/src/watcher/WatcherAsks.tsx#L110): `WatcherAskEntry` (110), `WatcherAskCard` (138) | 2 | Selected request answer or answered-choice entry. |
| [watcher/WatcherBeside.tsx:26](../../src/renderer/src/watcher/WatcherBeside.tsx#L26): `useRoomView` (26) | 1 | Shared room placement preference. |
| [watcher/checkQueues.ts:56](../../src/renderer/src/watcher/checkQueues.ts#L56): `useCheckQueues` (56) | 1 | Full queue view; deferred below. |
| [watcher/useMachines.ts:49](../../src/renderer/src/watcher/useMachines.ts#L49): `useMachines` (49) | 1 | Full connected-machine view. |
| [watcher/watchNotice.ts:49](../../src/renderer/src/watcher/watchNotice.ts#L49): `useWatchNotice` (49) | 1 | Shared current notice. |
| [watcher/watchOnSend.ts:36](../../src/renderer/src/watcher/watchOnSend.ts#L36): `useWatchOnSend` (36) | 1 | Own thread boolean. |
| [watcher/watcherFirstMessage.ts:129](../../src/renderer/src/watcher/watcherFirstMessage.ts#L129): `useFirstMessage` (129) | 1 | Shared first-message state; deferred below. |

## Bridge subscriber inventory (58)

These registrations update only their named domain, filter by owner/thread, or route an imperative action. Domain-only events can still fan out within a domain; the known deferred candidates are listed above.

| Subscriber | Registrations | Relevance / snapshot |
| --- | ---: | --- |
| [App.tsx:291](../../src/renderer/src/App.tsx#L291): `window.sotto?.popup?.onOpened` (291) | 1 | Imperative notification route. |
| [agents/AgentContext.tsx:318](../../src/renderer/src/agents/AgentContext.tsx#L318): `bridge?.onState` (318), `window.sotto?.onWindowVisible` (332), `bridge?.onThreadDetail` (333) | 3 | Shared agent state/detail and visibility catch-up; structural sharing and frame coalescing. |
| [agents/FolderBrowserDialog.tsx:125](../../src/renderer/src/agents/FolderBrowserDialog.tsx#L125): `bridge.onChanged` (125) | 1 | Hosts domain used by the folder picker. |
| [agents/HostUpdates.tsx:34](../../src/renderer/src/agents/HostUpdates.tsx#L34): `bridge.onChanged` (34) | 1 | Hosts update domain. |
| [agents/agentStateCatalogs.ts:70](../../src/renderer/src/agents/agentStateCatalogs.ts#L70): `bridge.onState` (70) | 1 | Wire-state reconstruction before AgentContext delivery. |
| [agents/delegations.ts:66](../../src/renderer/src/agents/delegations.ts#L66): `listen` (66) | 1 | Only rereads subscribed thread IDs named by the change. |
| [agents/mainCheckoutLine.logic.ts:14](../../src/renderer/src/agents/mainCheckoutLine.logic.ts#L14): `bridge.onChanged` (14) | 1 | Checkout state for the current main-checkout line. |
| [agents/nextPrompts.ts:27](../../src/renderer/src/agents/nextPrompts.ts#L27): `connect` (27) | 1 | Updates own-thread map entries. |
| [agents/requests/RequestDraftRecovery.tsx:81](../../src/renderer/src/agents/requests/RequestDraftRecovery.tsx#L81): `bridge?.onChanged` (81) | 1 | Relevant answer recovery notification. |
| [agents/requests/requestAnswers.ts:261](../../src/renderer/src/agents/requests/requestAnswers.ts#L261): `watch` (261) | 1 | Matches owner/request keys before updating entries. |
| [features/council/useCouncils.ts:25](../../src/renderer/src/features/council/useCouncils.ts#L25): `bridge.onChanged` (25) | 1 | Council-only invalidation, coalesced reads. |
| [features/memory/useMemory.ts:25](../../src/renderer/src/features/memory/useMemory.ts#L25): `bridge?.onChanged` (25) | 1 | Memory-only snapshot. |
| [features/omarchy/OmarchySetup.tsx:54](../../src/renderer/src/features/omarchy/OmarchySetup.tsx#L54): `bridge.onChanged` (54), `bridge.onFocus` (67) | 2 | Omarchy setup/focus state. |
| [features/onboarding/ComputersStep.tsx:41](../../src/renderer/src/features/onboarding/ComputersStep.tsx#L41): `bridge.onChanged` (41) | 1 | Hosts for onboarding. |
| [features/onboarding/PhoneStep.tsx:41](../../src/renderer/src/features/onboarding/PhoneStep.tsx#L41): `bridge.onChanged` (41) | 1 | Phone setup state. |
| [features/performance/useMainActivity.ts:20](../../src/renderer/src/features/performance/useMainActivity.ts#L20): `bridge.onChanged` (20) | 1 | Main-activity recording stream. |
| [features/settings/DictationShortcuts.tsx:99](../../src/renderer/src/features/settings/DictationShortcuts.tsx#L99): `window.sotto?.onKeyListenerPermission` (99) | 1 | Keyboard permission state. |
| [features/settings/HostQuestionDialog.tsx:53](../../src/renderer/src/features/settings/HostQuestionDialog.tsx#L53): `bridge.onChanged` (53) | 1 | Host questions. |
| [features/settings/HostsSettings.tsx:320](../../src/renderer/src/features/settings/HostsSettings.tsx#L320): `bridge.onChanged` (320) | 1 | Host settings state. |
| [features/settings/LocalAppsSettings.tsx:22](../../src/renderer/src/features/settings/LocalAppsSettings.tsx#L22): `bridge.onChanged` (22) | 1 | Local-app state. |
| [features/settings/PhonesSettings.tsx:85](../../src/renderer/src/features/settings/PhonesSettings.tsx#L85): `bridge.onChanged` (85) | 1 | Phone settings state. |
| [features/settings/PopupShortcutSetting.tsx:55](../../src/renderer/src/features/settings/PopupShortcutSetting.tsx#L55): `bridge.onState` (55) | 1 | Popup shortcut state. |
| [features/settings/SettingsView.tsx:334](../../src/renderer/src/features/settings/SettingsView.tsx#L334): `window.sotto?.onWindowHidden` (334) | 1 | Window visibility, commits pending settings. |
| [features/settings/useChordRecorder.ts:94](../../src/renderer/src/features/settings/useChordRecorder.ts#L94): `bridge?.onDictationKeysTaken` (94), `bridge.onDictationKeysHeld` (111) | 2 | Only an active recorder consumes chord/held-key events. |
| [features/starting/StartingScreen.tsx:74](../../src/renderer/src/features/starting/StartingScreen.tsx#L74): `bridge.onChanged` (74) | 1 | Hosts state used by starting screen. |
| [features/updates/UpdateAllCard.tsx:40](../../src/renderer/src/features/updates/UpdateAllCard.tsx#L40): `bridge.onChanged` (40) | 1 | Hosts update state. |
| [popup/PopupApp.tsx:79](../../src/renderer/src/popup/PopupApp.tsx#L79): `bridge.onShown` (79), `bridge.onThread` (122), `bridge.onThreadDetail` (123) | 3 | Shown refresh; thread/detail events filter the observed thread. |
| [popup.tsx:23](../../src/renderer/src/popup.tsx#L23): `bridge.onSettingsChanged` (23) | 1 | Settings drive popup appearance. |
| [state/AppContext.tsx:476](../../src/renderer/src/state/AppContext.tsx#L476): `bridge.onWindowMaximized` (476), `bridge.onRecoveryNotice` (521), `bridge.onUpdateStatus` (535), `bridge.onUpdateCheckRequested` (542), `bridge.onSpeechModelStatus` (549), `bridge.onSettingsChanged` (672), `bridge.onDictationCommand` (677), `bridge.onSettingsRequested` (938) | 8 | Separate settings/dictation/recovery/update/speech/window channels; microphone levels use a separate store. |
| [state/appearance.ts:96](../../src/renderer/src/state/appearance.ts#L96): `currentWindow()?.sotto?.glassWindow?.onChanged` (96) | 1 | Glass preference only. |
| [state/desktopNotifications.ts:17](../../src/renderer/src/state/desktopNotifications.ts#L17): `bridge?.onOpened` (17) | 1 | Imperative route on an opened desktop notification. |
| [state/hostsState.ts:11](../../src/renderer/src/state/hostsState.ts#L11): `bridge.onChanged` (11) | 1 | Own hosts snapshot. |
| [state/interfaceLanguage.ts:83](../../src/renderer/src/state/interfaceLanguage.ts#L83): `startInterfaceLanguage` (83) | 1 | Settings language, equality checked before language application. |
| [tools/BrowserPane.tsx:71](../../src/renderer/src/tools/BrowserPane.tsx#L71): `bridge.onEvent` (71) | 1 | Point events filter type, thread and page before changing the annotation. |
| [tools/browserStore.ts:384](../../src/renderer/src/tools/browserStore.ts#L384): `listen` (384) | 1 | Browser domain into cached per-thread state and task list. |
| [tools/changesStore.ts:143](../../src/renderer/src/tools/changesStore.ts#L143): `activate` (143) | 1 | Workspace/revision checks before diff refresh. |
| [tools/cloudIphoneStore.ts:47](../../src/renderer/src/tools/cloudIphoneStore.ts#L47): `listen` (47) | 1 | Per-thread sessions, separate service status. |
| [tools/subagentsStore.ts:72](../../src/renderer/src/tools/subagentsStore.ts#L72): `activate` (72) | 1 | Active thread/revision checks, keyed listener delivery. |
| [tools/terminalStore.ts:366](../../src/renderer/src/tools/terminalStore.ts#L366): `listen` (366) | 1 | Own terminal place/session; output goes directly to its native terminal view. |
| [watcher/MoveThreads.tsx:54](../../src/renderer/src/watcher/MoveThreads.tsx#L54): `use` (54), `use` (375) | 2 | Host/move domain into cached views. |
| [watcher/checkQueues.ts:24](../../src/renderer/src/watcher/checkQueues.ts#L24): `use` (24) | 1 | Checks domain into cached queue view. |
| [widget/WidgetApp.tsx:674](../../src/renderer/src/widget/WidgetApp.tsx#L674): `bridge.onWidgetState` (674), `bridge.onWidgetVisibilityChange` (679) | 2 | Widget state/visibility; palette effect depends on encoded colors, not changing audio levels. |

The additional registration is [`watcher/watcherRoom.tsx:147`](../../src/renderer/src/watcher/watcherRoom.tsx#L147), `roomChanges(...)`, backed by `shared/watcherRoomChanges.ts`'s `source.onChanged`. It reconstructs room deltas and is subject to the provider's ordering/identity rules described above.

## Agent-context consumer inventory (37)

These were followed for derived calculations, not counted as 37 additional IPC listeners. Thread lists/rosters generally need multiple threads; provider/worker picker consumers are the follow-up candidates above. Browser displays now retain their task slice, and Usage now retains its source-filter dependency.

| Source | Direct consumers |
| --- | --- |
| [agents/AgentAccountSettings.tsx:78](../../src/renderer/src/agents/AgentAccountSettings.tsx#L78) | `AgentSetupFields` (78) |
| [agents/ClientUpdateCard.tsx:28](../../src/renderer/src/agents/ClientUpdateCard.tsx#L28) | `ClientUpdateCard` (28) |
| [agents/PageSidebar.tsx:36](../../src/renderer/src/agents/PageSidebar.tsx#L36) | `PageSidebar` (36) |
| [agents/ProvidersSettings.tsx:102](../../src/renderer/src/agents/ProvidersSettings.tsx#L102) | `ProvidersSettings` (102) |
| [agents/SidebarFrame.tsx:155](../../src/renderer/src/agents/SidebarFrame.tsx#L155) | `RailWatcher` (155) |
| [agents/ThreadWorkspace.tsx:29](../../src/renderer/src/agents/ThreadWorkspace.tsx#L29) | `ThreadWorkspace` (29) |
| [agents/ThreadsView.tsx:138](../../src/renderer/src/agents/ThreadsView.tsx#L138) | `ThreadsView` (138) |
| [features/council/CouncilChamber.tsx:117](../../src/renderer/src/features/council/CouncilChamber.tsx#L117) | `CouncilChamber` (117) |
| [features/council/CouncilView.tsx:42](../../src/renderer/src/features/council/CouncilView.tsx#L42) | `CouncilView` (42), `AskForm` (97), `RowRecord` (313), `Verdict` (372) |
| [features/onboarding/AgentsStep.tsx:62](../../src/renderer/src/features/onboarding/AgentsStep.tsx#L62) | `AgentsStep` (62) |
| [features/onboarding/Onboarding.tsx:201](../../src/renderer/src/features/onboarding/Onboarding.tsx#L201) | `Onboarding` (201) |
| [features/onboarding/ProjectStep.tsx:55](../../src/renderer/src/features/onboarding/ProjectStep.tsx#L55) | `ProjectStep` (55) |
| [features/performance/MainActivityParts.tsx:67](../../src/renderer/src/features/performance/MainActivityParts.tsx#L67) | `useAttach` (67) |
| [features/settings/ClearThreadsSettings.tsx:60](../../src/renderer/src/features/settings/ClearThreadsSettings.tsx#L60) | `ClearThreadsSettings` (60) |
| [features/settings/CouncilSettings.tsx:23](../../src/renderer/src/features/settings/CouncilSettings.tsx#L23) | `CouncilSettings` (23) |
| [features/settings/HostDialog.tsx:59](../../src/renderer/src/features/settings/HostDialog.tsx#L59) | `HostDialog` (59) |
| [features/settings/HostProviders.tsx:128](../../src/renderer/src/features/settings/HostProviders.tsx#L128) | `ProviderTile` (128) |
| [features/settings/HostsSettings.tsx:315](../../src/renderer/src/features/settings/HostsSettings.tsx#L315) | `HostsSettings` (315) |
| [features/settings/ProjectThreadDefaults.tsx:19](../../src/renderer/src/features/settings/ProjectThreadDefaults.tsx#L19) | `ProjectThreadDefaults` (19) |
| [features/settings/WorkerMachineSettings.tsx:97](../../src/renderer/src/features/settings/WorkerMachineSettings.tsx#L97) | `WorkerMachineSettings` (97) |
| [features/settings/WorkerRolesSettings.tsx:89](../../src/renderer/src/features/settings/WorkerRolesSettings.tsx#L89) | `WorkerRolesSettings` (89) |
| [features/starting/StartingScreen.tsx:135](../../src/renderer/src/features/starting/StartingScreen.tsx#L135) | `StartingScreen` (135) |
| [features/updates/UpdateAllCard.tsx:142](../../src/renderer/src/features/updates/UpdateAllCard.tsx#L142) | `UpdateAllCard` (142) |
| [features/usage/UsageView.tsx:51](../../src/renderer/src/features/usage/UsageView.tsx#L51) | `UsageView` (51) |
| [tools/BrowserPane.tsx:34](../../src/renderer/src/tools/BrowserPane.tsx#L34) | `BrowserPane` (34) |
| [tools/BrowserSurface.tsx:43](../../src/renderer/src/tools/BrowserSurface.tsx#L43) | `ClassicBrowserSurface` (43) |
| [tools/IPhoneSurface.tsx:83](../../src/renderer/src/tools/IPhoneSurface.tsx#L83) | `IPhoneSurface` (83) |
| [tools/TerminalViewProblem.tsx:9](../../src/renderer/src/tools/TerminalViewProblem.tsx#L9) | `TerminalViewProblem` (9) |
| [tools/ToolsPanel.tsx:245](../../src/renderer/src/tools/ToolsPanel.tsx#L245) | `ToolsPanel` (245) |
| [watcher/MoveThreads.tsx:238](../../src/renderer/src/watcher/MoveThreads.tsx#L238) | `MoveThreadsSheet` (238) |
| [watcher/WatcherContextTile.tsx:75](../../src/renderer/src/watcher/WatcherContextTile.tsx#L75) | `WatcherContextTile` (75) |
| [watcher/WatcherView.tsx:340](../../src/renderer/src/watcher/WatcherView.tsx#L340) | `WatcherPane` (340), `WatcherView` (498) |
| [watcher/watcherRoom.tsx:136](../../src/renderer/src/watcher/watcherRoom.tsx#L136) | `WatcherRoomProvider` (136) |

## Verification

Only targeted single-file Vitest commands, typecheck and lint are run for this work. No full suite, Playwright, design capture, app launch or runtime screenshot is part of the evidence. New regressions were also run with the original production files restored temporarily: both Tools cases and both Usage source cases failed their unrelated-broadcast count assertion before the fix; the modified files were then restored.

Local Node 25 exposes experimental Web Storage ahead of jsdom. Completed single-file runs on that version use `NODE_OPTIONS=--no-experimental-webstorage` so the existing test setup receives jsdom's `localStorage`; no project environment workaround was added. An initial parallel attempt on the remaining existing surface files spent over 14 minutes in imports/execution; Usage completed with three 15-second deadline failures and the other three files were stopped. The iPhone, phone-player and Tools files then passed serially with the installed CI version, Node 24.22.1. Usage's three timed-out cases passed on that version with a 60-second CLI deadline; its other 27 cases had passed in the initial run. No repository deadline was changed.


Final results: `npm run typecheck` and the full `npm run lint` passed. Each Vitest invocation named one file. The final targeted invocations below total **129 passed, 27 skipped**; the skips are the already-passed Usage cases excluded from its focused retry.

| File under `tests/unit/renderer/` | Final result | Runtime / arguments |
| --- | --- | --- |
| `tools/browserTaskSubscriptions.test.tsx` | 3 passed | Node 25, Web Storage disabled |
| `tools/browserPane.test.tsx` | 34 passed | Node 25, Web Storage disabled |
| `tools/browserSurface.test.tsx` | 30 passed | Node 25, Web Storage disabled |
| `tools/iphoneSurface.test.tsx` | 13 passed | Node 24, `--maxWorkers=1` |
| `tools/phonePlayer.test.tsx` | 13 passed | Node 24, `--maxWorkers=1` |
| `tools/toolsPanel.test.tsx` | 31 passed | Node 24, `--maxWorkers=1` |
| `usageBroadcasts.test.tsx` | 2 passed | Node 25, Web Storage disabled |
| `usageView.test.tsx` | 3 passed, 27 skipped | Node 24, `--maxWorkers=1 --testTimeout=60000 --testNamePattern='keeps an offline computer\|gives each provider one section\|reads a provider again'` |

The initial Usage deadline failures were `keeps an offline computer named and shows one without history as waiting for its update`, `gives each provider one section with its freshest reading and other computers beside it`, and `reads a provider again on request, Claude included, and keeps focus on the button`. All three passed in the focused retry (468 ms total test execution). Tools' existing jsdom canvas-not-implemented messages did not fail its tests.
