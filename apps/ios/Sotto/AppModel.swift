import Foundation
import SwiftUI
import SottoCore

// Watcher on this iPhone (ADR-0073, amended October 11, 2026): the Watcher tab reads the page of the computer that runs
// Watcher, which comes with each of its shells, and sends the user's own words, answers and Stop all to it. Watcher
// answers nothing, and nothing here is sent again on its own.
extension AppModel {
    static let watcherFeature = WatcherWire.feature
    static let watcherStopFeature = WatcherWire.stopFeature
    static let watcherSteerFeature = WatcherWire.steerFeature

    /// Whether this computer runs Watcher and shows it to this iPhone: an Owl desktop, after this iPhone opted in.
    func offersWatcher(_ hostID: String) -> Bool { live[hostID]?.features.contains(Self.watcherFeature) == true }
    func offersWatcherStop(_ hostID: String) -> Bool { offersWatcher(hostID) && live[hostID]?.features.contains(Self.watcherStopFeature) == true }
    /// Whether this computer takes a message while Watcher works (#1229): Send steers into Watcher's turn, or the words go
    /// next as their own turn, and a follow-up waiting for Watcher can be removed. An older one refuses it while Watcher works.
    func offersWatcherSteer(_ hostID: String) -> Bool { offersWatcher(hostID) && live[hostID]?.features.contains(Self.watcherSteerFeature) == true }
    /// Whether this computer's Watcher page names its machines (#1032): the line under Watcher's name and each machine's
    /// panel. Only a computer with Work across machines on offers it.
    func offersWatcherMachines(_ hostID: String) -> Bool { offersWatcher(hostID) && live[hostID]?.features.contains(WatcherWire.machinesFeature) == true }
    /// The computer whose Watcher the Watcher tab shows: the one last chosen, by a Watcher alert or the menu in the tab's
    /// header, while it still runs Watcher, and otherwise the first paired computer that runs one. With none, there is no
    /// tab, and nothing else in the app changes.
    var watcherHostID: String? {
        if let chosen = chosenWatcherHost, offersWatcher(chosen) { return chosen }
        return computers.first { offersWatcher($0.hostID) }?.hostID
    }
    /// Every paired computer whose Watcher this iPhone can show, in the order they were added.
    var watcherHostIDs: [String] { computers.filter { offersWatcher($0.hostID) }.map(\.hostID) }
    /// Shows this computer's Watcher on the Watcher tab.
    func chooseWatcher(_ hostID: String) {
        guard offersWatcher(hostID), chosenWatcherHost != hostID else { return }
        chosenWatcherHost = hostID
    }
    /// Watcher's page, from `watcherStore`. A view that reads it watches that store, which publishes on its own: the
    /// page's conversation grows with every shell while Watcher answers, and only the Watcher tab reads it.
    func watcherPage(_ hostID: String) -> WatcherPage? { offersWatcher(hostID) ? watcherStore.pages[hostID] : nil }
    /// What the rest of the app reads of Watcher's page, published on the model only when it changes.
    private func watcherSummary(_ hostID: String) -> WatcherSummary? { offersWatcher(hostID) ? live[hostID]?.watcherSummary : nil }
    /// The tab's dot and badge. A computer that can't be reached claims neither.
    var watcherTab: WatcherTabState {
        guard let hostID = watcherHostID, online(hostID) else { return WatcherTabState(working: false, needs: 0) }
        let refs = listed.refs ?? Set(lists.flatMap { list in list.threads.map { ThreadRef(hostID: list.hostID, threadID: $0.id).id } })
        listed.refs = refs
        return WatcherTabState(summary: watcherSummary(hostID), listed: { refs.contains($0.id) })
    }
    /// The thread lists grouped as Threads shows them, worked out once until a computer's list changes.
    func focusThreads(show: ComputerFilter = .all, query: String = "", opened: ThreadRef? = nil) -> FocusThreads {
        let holding = holdingThreads
        let key = Listed.GroupKey(show: show, query: query, opened: opened, holding: holding)
        if let kept = listed.groups[key] { return kept }
        // Each search typed is its own key; a list that stays the same while the user types keeps only the latest few.
        if listed.groups.count >= 8 { listed.groups = [:] }
        let groups = FocusThreads(lists, show: show, query: query, opened: opened, holding: holding)
        listed.groups[key] = groups
        return groups
    }
    /// The threads this iPhone holds something for, by `ThreadRef.id`: words, photos or files in the reply box, a refused
    /// reply, or anything sent and not yet confirmed. An unsent thread is listed only while it is one of these.
    private var holdingThreads: Set<String> {
        var refs = Set(drafts.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.keys)
        refs.formUnion(draftPhotos.filter { !$0.value.isEmpty }.keys)
        refs.formUnion(draftFiles.filter { !$0.value.isEmpty }.keys)
        refs.formUnion(failedReplies.keys)
        refs.formUnion(pending.map { ThreadRef(hostID: $0.hostID, threadID: $0.threadID).id })
        return refs
    }
    /// The Threads tab's badge: the requests Needs you shows, and the Recent threads that finished while nothing showed
    /// them and have not been opened on either device (ADR-0046). A delegated thread counts only through the row that
    /// stands for it (ADR-0081).
    var threadsBadge: Int {
        if let kept = listed.badge, kept.opened == selected { return kept.count }
        let groups = focusThreads(opened: selected)
        let count = groups.requestCount + groups.unreadFinishedCount
        listed.badge = (opened: selected, count: count)
        return count
    }
    /// Whether Watcher works with this thread now: the owl after its provider's logo, and the line in its reply box.
    func watchedByWatcher(_ ref: ThreadRef) -> Bool {
        computers.contains { watcherSummary($0.hostID)?.watched.contains(ref.id) == true }
    }
    /// Every thread Watcher works with now, by `ThreadRef.id`, for a list to read once.
    var watchedThreadIDs: Set<String> {
        Set(computers.flatMap { computer in watcherSummary(computer.hostID)?.watched ?? [] })
    }
    /// The name a thread's computer goes by here, or nil for a computer this iPhone isn't paired with.
    func computerName(_ hostID: String) -> String? { computer(hostID)?.name }
    /// Watcher's model, as its computer names it: "Codex · GPT-6.1 Sol", with OpenCode's model source or Cursor's model maker
    /// when it has one.
    func watcherModel(_ hostID: String) -> String? {
        guard let current = watcherPage(hostID)?.current else { return nil }
        let model = live[hostID]?.shell?.host.models?.first { $0.id == current.modelId }
        return ThreadModel.label(providerID: current.provider, source: model?.source, name: model?.name ?? current.modelId)
    }

    // MARK: Watcher's page

    /// Reads Watcher's page again, when the user pulls to refresh, after an unconfirmed action, or when a hello came
    /// without it. Every shell from the computer carries it otherwise. One read at a time on each computer; a request
    /// during a read asks for one more after it, which runs even when this one fails or its connection changes. A read that
    /// fails says so, on the page and in the box, until one works.
    func readWatcher(_ hostID: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { refreshFixtureWatcher(on: hostID); return }
        #endif
        guard offersWatcher(hostID), online(hostID) else { return }
        guard watcherReads.insert(hostID).inserted else { watcherRereads.insert(hostID); return }
        defer { watcherReads.remove(hostID) }
        repeat {
            watcherRereads.remove(hostID)
            guard online(hostID), let connection = connections[hostID], let epoch = generations[hostID] else { return }
            // Drafts whose send has ended before this read is asked for: its page says where they stand.
            let proof = watcherDrafts[hostID]?.endedSends ?? [:]
            do {
                let reply = try await connection.call(WatcherWire.read, as: WatcherPhoneResult.self)
                // Over a connection that has since changed: its page is left, and a read asked for meanwhile still runs.
                guard generations[hostID] == epoch else { continue }
                switch reply {
                case .ok(let page):
                    if !applyWatcher(page, from: hostID, proof: proof) { setWatcherReadProblem(Self.watcherUnreadable(name(hostID)), on: hostID) }
                case .refused(let refusal):
                    setWatcherReadProblem(refusal.message, on: hostID)
                }
            } catch let refusal as HostRefusal {
                if generations[hostID] == epoch { setWatcherReadProblem(refusal.localizedDescription, on: hostID) }
                continue
            } catch {
                if generations[hostID] == epoch { setWatcherReadProblem(Self.watcherUnreadable(name(hostID)), on: hostID) }
                continue
            }
        } while watcherRereads.contains(hostID)
    }
    /// Reads Watcher's page with each machine's facts read afresh (#1032): when the user opens a machine's numbers, or
    /// Watcher has placed work the line has not been read for. Never on a timer. One at a time on each computer; a request
    /// during one asks for one more after it, so a placement made meanwhile is still read for. A read that fails leaves the
    /// last page, whose machines say when they were read.
    func readWatcherMachines(_ hostID: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard offersWatcherMachines(hostID), online(hostID) else { return }
        guard watcherMachineReads.insert(hostID).inserted else { watcherMachineRereads.insert(hostID); return }
        defer { watcherMachineReads.remove(hostID) }
        repeat {
            watcherMachineRereads.remove(hostID)
            guard online(hostID), let connection = connections[hostID], let epoch = generations[hostID] else { return }
            guard case .ok(let page)? = try? await connection.call(WatcherWire.readMachines, as: WatcherPhoneResult.self),
                  generations[hostID] == epoch else { continue }
            applyWatcher(page, from: hostID)
        } while watcherMachineRereads.contains(hostID)
    }
    /// Reads the machines once for each set of Watcher's starts the line has not been read for (#1032), so the line's words
    /// follow a start. Starts are the page's start receipts; the same set is not read for twice while the app runs.
    func readWatcherMachinesAfterStarts(_ hostID: String) {
        guard offersWatcherMachines(hostID), let page = watcherPage(hostID) else { return }
        let starts = page.receiptGroups.flatMap { $0.rows }.filter { $0.action == "start" }.map(\.operationId).joined(separator: ",")
        guard !starts.isEmpty, watcherStore.machinesReadFor[hostID] != starts else { return }
        watcherStore.machinesReadFor[hostID] = starts
        Task { await readWatcherMachines(hostID) }
    }
    static func watcherUnreadable(_ computer: String) -> String {
        String(localized: "Watcher on \(computer) couldn’t be read. Nothing was lost. Pull down to read it again.", comment: "%@ is the computer's name")
    }
    /// Why Watcher's page couldn't be read, or nil once it is. Set only when it changes, so nothing redraws for nothing.
    private func setWatcherReadProblem(_ problem: String?, on hostID: String) {
        if watcherReadProblems[hostID] != problem { watcherReadProblems[hostID] = problem }
    }
    /// Takes a page from its computer, unless it names another computer or is older than the one shown. False when the
    /// page doesn't belong to the computer that sent it.
    /// `proof` holds the draft IDs whose send had ended when this page was asked for (see `WatcherDrafts.retire`).
    @discardableResult private func applyWatcher(_ page: WatcherPage, from hostID: String, proof: [String: Int] = [:]) -> Bool {
        guard offersWatcher(hostID), (try? page.validate(hostID: hostID)) != nil else { return false }
        setWatcherReadProblem(nil, on: hostID)
        if let shown = watcherStore.pages[hostID], page.isOlder(than: shown) { return true }
        showWatcher(page, on: hostID)
        noticeWatcher(page, from: hostID)
        settleWatcherDraft(page, on: hostID, proof: proof)
        // A card that left the page settles the answer this iPhone sent it, unless that answer is still being checked.
        for item in scoped(hostID) where item.kind == "watcher-answer" {
            if connecting.contains(hostID) || dispatchingOperations.keys.contains(item.id) || (deliveryChecks[hostID] ?? 0) > 0 { continue }
            do { try settle(item, shell: live[hostID]?.shell) } catch { feedback = error.localizedDescription }
        }
        return true
    }
    /// Shows a page: the whole page on its own store, and only what the rest of the app reads on the model, so a growing
    /// conversation redraws the Watcher tab and nothing else.
    private func showWatcher(_ page: WatcherPage, on hostID: String) {
        if watcherStore.pages[hostID] != page { watcherStore.pages[hostID] = page; publishOnModelIfComparing() }
        update(hostID) { $0.watcherSummary = WatcherSummary(page) }
    }
    /// Watcher's own requests and errors alert under the switches every thread uses; its finished turns never do.
    private func noticeWatcher(_ page: WatcherPage, from hostID: String) {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        var watch = watcherWatches[hostID] ?? WatcherWatch()
        let switches = AlertSwitches(needsYou: preferences.notifyNeedsYou, finished: preferences.notifyFinished, failed: preferences.notifyFailed)
        // Quiet only for the Watcher on screen; another computer's Watcher still alerts while the tab is open.
        let onScreen = foreground && watcherOnScreen && watcherHostID == hostID
        let news = watch.observe(page, hostID: hostID, computer: name(hostID), onScreen: onScreen, switches: switches)
        watcherWatches[hostID] = watch
        guard let alerts, !news.isEmpty else { return }
        for alert in news { alerts.post(alert, sound: preferences.notifySound) }
    }

    // MARK: Asking Watcher

    /// The Watcher box's words live with the other reply boxes, under this key.
    func watcherDraftKey(_ hostID: String) -> String { PhotoBox.watcher(hostID: hostID).id }
    /// Why the Watcher box can't send now, in a sentence, or nil when it can. A computer that can't be reached says so in
    /// its own banner.
    func watcherSendHeld(_ hostID: String) -> String? {
        guard online(hostID) else { return nil }
        guard let page = watcherPage(hostID) else {
            return watcherReadProblems[hostID] ?? String(localized: "Reading Watcher on \(name(hostID))…", comment: "%@ is the computer's name")
        }
        guard let current = page.current else {
            return String(localized: "Watcher isn’t running on \(name(hostID)). Start it in Sotto on \(name(hostID)), then ask it here.", comment: "Both placeholders are the computer's name")
        }
        if !current.connected {
            return String(localized: "\(AgentNames.name(current.provider)) isn’t connected on \(name(hostID)), so Watcher can’t take messages. Nothing was sent.", comment: "The first placeholder is the provider's name, such as Codex; the second is the computer's name")
        }
        if page.needsYou.contains(where: { page.isOwn($0) }) { return String(localized: "Answer Watcher’s request first.") }
        return nil
    }
    /// Whether the Watcher box holds something it can send now: words, photos or both, every photo prepared, and photos
    /// only to a Watcher whose model takes them.
    func canSendToWatcher(_ hostID: String) -> Bool {
        let box = PhotoBox.watcher(hostID: hostID), photos = self.photos(box)
        let text = drafts[box.id] ?? ""
        let written = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return online(hostID) && watcherSendHeld(hostID) == nil && watcherSending[hostID] == nil && !preparingSends.contains(box.id)
            && (written || !photos.isEmpty) && text.utf16.count <= 20_000
            && !photos.contains(where: \.preparing) && (photos.isEmpty || photoSupport(box) == .available)
    }
    /// Sends the box's words and photos to Watcher as the user's own instruction, from this iPhone. While Watcher works, a computer
    /// that takes it steers them into Watcher's turn, or queues them to go next when it can't (#1229, Zach's pick B); an
    /// older one refuses them, and the box says to update Sotto there. Refused or unconfirmed, the words
    /// go back in the box, or are kept under the conversation when newer words are there, and nothing is sent again on
    /// its own. The same words keep the same draft ID until Watcher's
    /// computer says it took them, through any other words sent in between, so sending them again after an unconfirmed
    /// send can't deliver them twice, and a later page that says Watcher took them clears them.
    func sendToWatcher(_ hostID: String) async {
        guard canSendToWatcher(hostID), computer(hostID) != nil, var current = watcherPage(hostID)?.current else { return }
        let box = PhotoBox.watcher(hostID: hostID), key = box.id
        // The words as pressed. A message with photos locks the box from the press until Watcher answers, so nothing typed
        // or chosen meanwhile joins it, and a message that comes back finds the box as it left it.
        let text = drafts[key] ?? ""
        var photos = self.photos(box)
        var images: [StagedImage] = []
        if !photos.isEmpty {
            preparingSends.insert(box.id)
            guard let ready = await readyPhotos(box) else { preparingSends.remove(box.id); return }
            images = ready
            // Watcher may have changed or been held while the photos were staged: the message stays in the box.
            guard online(hostID), watcherSendHeld(hostID) == nil, watcherSending[hostID] == nil, photoSupport(box) == .available,
                  let now = watcherPage(hostID)?.current, now.target == current.target else {
                preparingSends.remove(box.id)
                photoNotices[box.id] = String(localized: "Your message wasn’t sent. It’s still in the box.", comment: "A message to Watcher that wasn't sent")
                return
            }
            current = now
            // As staged: their handles are what their message's photos carry, and what the box gets back.
            photos = self.photos(box)
        }
        guard let computer = computer(hostID) else { preparingSends.remove(box.id); return }
        // The host holds a draft ID to one packet, its photos' handles included: photos staged again go as another message.
        let draftID = watcherDrafts[hostID, default: WatcherDrafts()].id(for: text, photos: images.map(\.id))
        watcherSending[hostID] = text; drafts[key] = ""
        if !photos.isEmpty { watcherSendingPhotos[hostID] = photos; draftPhotos[key] = nil; photoNotices[key] = nil }
        defer {
            watcherSending[hostID] = nil
            watcherSendingPhotos[hostID] = nil
            preparingSends.remove(box.id)
            watcherDrafts[hostID]?.end(draftID)
            // The page read after a lost acknowledgement came while the words were still on their way, and may say
            // Watcher took them: settled now, they leave the box.
            if let page = watcherPage(hostID) { settleWatcherDraft(page, on: hostID, proof: [:]) }
        }
        #if DEBUG && os(iOS)
        if isUIFixture { await sendToFixtureWatcher(text, on: hostID); watcherDrafts[hostID]?.resolve(draftID); return }
        #endif
        guard let connection = connections[hostID], let epoch = generations[hostID] else { restoreWatcherDraft(text, photos: photos, on: hostID, unconfirmed: false); return }
        let steer = offersWatcherSteer(hostID)
        // Whether Watcher's turn ran when these words left: an older computer's refusal of them says only that, even if a
        // page saying Watcher finished arrives before it.
        let workingAtSend = current.status == "running"
        let operation = WatcherWire.send(target: current.target, clientID: computer.pairing.clientId, draftID: draftID, text: text, steer: steer, images: images)
        do {
            let reply = try await connection.call(operation, as: WatcherSendResult.self)
            // A reply over a connection that has since changed doesn't say what happened to the words.
            guard generations[hostID] == epoch else {
                feedback = restoreWatcherDraft(text, photos: photos, on: hostID, unconfirmed: true) ? Self.watcherUnconfirmed : Self.watcherUnconfirmedSetAside
                return
            }
            switch reply {
            case .ok(_, let state):
                watcherDrafts[hostID]?.resolve(draftID)
                // Watcher's conversation draws them from here, under the IDs its message's photos carry, without asking for them.
                if !photos.isEmpty { photosSent?(photos, ThreadRef(hostID: hostID, threadID: current.target.threadId)) }
                applyWatcher(state, from: hostID)
            case .refused(let refusal):
                // A page pushed while the words were on their way may already say Watcher took them or that they wait in
                // its queue. Its word wins: put back in the box, they could be sent a second time.
                if let page = watcherPage(hostID), page.delivery(of: draftID) == "accepted" || page.followup(of: draftID) != nil {
                    watcherDrafts[hostID]?.resolve(draftID)
                    return
                }
                // A refused message's photos are staged again before they go, as a refused reply's are (ADR-0031), unless
                // the computer can't say whether Watcher took it: sent again, it is then the same message.
                restoreWatcherDraft(text, photos: photos, on: hostID, unconfirmed: false, restage: refusal.code != "DELIVERY_UNCERTAIN")
                // An older computer refuses a message while Watcher works, in words that don't say why.
                let busy = !steer && refusal.code == "PROVIDER_UNAVAILABLE" && workingAtSend
                feedback = busy ? WatcherWords.updateToSteer(name(hostID)) : refusal.message
            }
        } catch let refusal as HostRefusal {
            restoreWatcherDraft(text, photos: photos, on: hostID, unconfirmed: false, restage: true)
            feedback = refusal.localizedDescription
        } catch {
            // Lost on its way, perhaps after Watcher took it. Its part on the wire has ended either way, so the page read
            // now, after it on the same connection, says where the draft stands; the box waits until that read is done.
            // A page that already says Watcher took it settles it; otherwise the words go back in the box, or under the
            // conversation, and the page is read again.
            watcherDrafts[hostID]?.end(draftID)
            // Taken, or waiting in Watcher's queue to go next: either way the computer has the words.
            if watcherPage(hostID)?.delivery(of: draftID) == "accepted" || watcherPage(hostID)?.followup(of: draftID) != nil {
                watcherDrafts[hostID]?.resolve(draftID)
            } else {
                feedback = restoreWatcherDraft(text, photos: photos, on: hostID, unconfirmed: true) ? Self.watcherUnconfirmed : Self.watcherUnconfirmedSetAside
                await readWatcher(hostID)
            }
        }
    }
    static let watcherUnconfirmed = String(localized: "Watcher didn’t confirm your message, so it’s back in the box. Check the conversation before you send it again.")
    static let watcherUnconfirmedSetAside = String(localized: "Watcher didn’t confirm your message. It’s kept under the conversation, because the box has newer words. Check the conversation before you send it again.")
    /// Puts words that didn't reach Watcher, or that it didn't confirm, back in its box. When the user has written
    /// something new there since, they are kept under the conversation instead, to be put back once the box is empty.
    /// Says whether they went back in the box. Photos always go back in the box: it stayed locked while they were away. With
    /// `restage`, they are staged again before they next go.
    @discardableResult private func restoreWatcherDraft(_ text: String, photos: [DraftPhoto] = [], on hostID: String, unconfirmed: Bool,
                                                        restage: Bool = false) -> Bool {
        let key = watcherDraftKey(hostID)
        let returned = restage ? photos.map { var photo = $0; photo.staged = nil; photo.stagedAt = nil; return photo } : photos
        if !returned.isEmpty { draftPhotos[key] = (draftPhotos[key] ?? []) + returned }
        let box = drafts[key] ?? ""
        if box.isEmpty || box == text { drafts[key] = text; return true }
        var kept = watcherSetAside[hostID] ?? []
        kept.removeAll { $0.text == text }
        kept.append(WatcherSetAside(text: text, unconfirmed: unconfirmed))
        watcherSetAside[hostID] = kept
        return false
    }
    /// Whether words kept under the conversation can go back in Watcher's box: once it is empty, and not while a message
    /// with photos is on its way, whose words and photos come back to the box together if it doesn't go.
    func canRestoreWatcherWords(on hostID: String) -> Bool {
        let box = PhotoBox.watcher(hostID: hostID)
        return (drafts[box.id] ?? "").isEmpty && !preparingSends.contains(box.id)
    }
    /// Puts words kept under the conversation back in Watcher's box, once it is empty.
    func restoreWatcherWords(_ words: WatcherSetAside, on hostID: String) {
        let key = watcherDraftKey(hostID)
        guard canRestoreWatcherWords(on: hostID), var kept = watcherSetAside[hostID], let index = kept.firstIndex(of: words) else { return }
        drafts[key] = words.text
        kept.remove(at: index)
        watcherSetAside[hostID] = kept.isEmpty ? nil : kept
    }
    /// Words put back after an unconfirmed send leave the box once Watcher's computer says it took them. A page asked for
    /// after their send ended (`proof`) also lets go of draft IDs it no longer shows on their way, so the same words sent
    /// again later go as a new message. It runs while a send is on its way too: that send's draft hasn't ended, so no page
    /// lets go of it, and the read after a lost acknowledgement is how its draft is settled.
    private func settleWatcherDraft(_ page: WatcherPage, on hostID: String, proof: [String: Int]) {
        guard watcherDrafts[hostID] != nil else { return }
        let taken = watcherDrafts[hostID]?.retire(after: page, proof: proof) ?? []
        guard !taken.isEmpty else { return }
        let key = watcherDraftKey(hostID)
        for sent in taken {
            // Only the whole message leaves the box, its words and photos together: one the user has changed since stays.
            if drafts[key] == sent.text && (draftPhotos[key] ?? []).map(\.staged?.id) == sent.photos.map(Optional.some) {
                drafts[key] = ""; draftPhotos[key] = nil
            }
            if let kept = watcherSetAside[hostID] {
                let left = kept.filter { $0.text != sent.text }
                if left != kept { watcherSetAside[hostID] = left.isEmpty ? nil : left }
            }
        }
        if feedback == Self.watcherUnconfirmed || feedback == Self.watcherUnconfirmedSetAside { feedback = nil }
    }

    // MARK: Cards in Watcher's page (4B)

    /// Where the answer to a card in Watcher's page goes, whether or not it can be answered now: through Watcher's page
    /// for a thread on the computer that runs Watcher, or to the thread's own computer when this iPhone is paired with
    /// it. Nil for a thread on a computer this iPhone isn't paired with.
    func watcherCardPlace(_ card: WatcherPage.RequestCard, on hostID: String) -> RequestPlace? {
        if card.target.hostId == hostID { return .watcher(hostID: hostID, target: card.target.ref) }
        return computer(card.target.hostId) != nil ? .thread(card.target.ref) : nil
    }
    /// Whether a card in Watcher's page can be answered from here, with the request as the computer that holds it has it
    /// now. A card for a thread on another computer is Watcher's copy, not that computer's word: it is answered only
    /// while that computer, reached now, still holds the same request in that thread. Otherwise the card says why.
    func watcherCardRoute(_ card: WatcherPage.RequestCard, on hostID: String) -> WatcherCardRoute {
        guard let place = watcherCardPlace(card, on: hostID) else {
            return .note(String(localized: "Answer this one in Sotto on \(name(hostID)).", comment: "%@ is the computer's name"))
        }
        switch place {
        case .watcher:
            guard let request = waitingRequest(card.request.id, at: place) else { return .note(Self.requestNoLongerWaiting) }
            return .answer(place, request)
        case .thread(let ref):
            let computer = name(ref.hostID)
            guard online(ref.hostID) else { return .note(String(localized: "Reconnect to \(computer) to answer this one.", comment: "%@ is the computer's name")) }
            guard let request = waitingRequest(card.request.id, at: place), request.kind == card.request.kind else {
                return .note(String(localized: "This request is no longer waiting on \(computer). Nothing was answered.", comment: "%@ is the computer's name"))
            }
            return .answer(place, request)
        }
    }
    /// Whether a card in Watcher's page can take an answer through Watcher's computer now. The computer checks Can answer
    /// again. A card for a thread on another computer is answered there, through that computer's own pairing.
    func canAnswerWatcherCard(_ card: WatcherPage.RequestCard, on hostID: String) -> Bool {
        guard online(hostID), mayAnswer(hostID), card.mayAnswer, card.connected, card.request.supported, !answering(hostID),
              card.target.hostId == hostID, watcherPage(hostID)?.card(card.target.ref, requestID: card.request.id) != nil else { return false }
        return true
    }
    /// The answer this iPhone sent to a card in Watcher's page, while its computer hasn't confirmed it.
    func watcherAnswerMarker(_ card: WatcherPage.RequestCard, on hostID: String) -> PendingOperation? {
        scoped(hostID).first { $0.kind == "watcher-answer" && $0.threadID == card.target.threadId && $0.requestID == card.request.id }
    }
    /// Answers a card in Watcher's page as the user's own answer to the thread that asked, through the computer that runs
    /// Watcher, which checks Can answer before it acts. Answering keeps the thread watched; Watcher answers nothing.
    func answerWatcherCard(_ card: WatcherPage.RequestCard, on hostID: String, choice: String? = nil, text: String = "",
                           answers: [String: QuestionAnswer] = [:]) async {
        guard canAnswerWatcherCard(card, on: hostID), let computer = computer(hostID), let page = watcherPage(hostID) else { return }
        let waiting = page.needsYou.filter { $0.target == card.target }.map(\.request)
        do {
            let command = try Commands.answer(threadID: card.target.threadId, request: card.request, currentRequests: waiting,
                                              choice: choice, text: text, answers: answers)
            guard case .object(let fields) = command else { throw ClientError.invalidRequest }
            let request = try WatcherWire.answer(target: card.target, command: fields)
            #if DEBUG && os(iOS)
            if isUIFixture { settleFixtureWatcherCard(card, on: hostID); return }
            #endif
            guard let connection = connections[hostID] else { return }
            let epoch = generations[hostID]
            let operation = PendingOperation(hostID: hostID, clientID: computer.pairing.clientId, threadID: card.target.threadId,
                                             requestID: card.request.id, kind: "watcher-answer")
            try remember(operation)
            dispatchingOperations[operation.id] = .some(epoch)
            defer { dispatchingOperations[operation.id] = nil }
            do {
                // The request's ID is the marker's, so a lost acknowledgement reads this answer's own receipt.
                let reply = try await connection.call(request, as: WatcherPhoneResult.self, id: operation.id)
                guard generations[hostID] == epoch else { return }
                switch reply {
                case .ok(let state):
                    applyWatcher(state, from: hostID)
                    // Only this answer's own receipt says it reached the thread.
                    await checkDelivery(hostID)
                case .refused(let refusal):
                    try rejectOperation(operation)
                    feedback = refusal.message
                }
            } catch let error as HostRefusal {
                guard generations[hostID] == epoch else { return }
                if ["invalid_request", "stale_request", "forbidden", "busy"].contains(error.failure.code) { try rejectOperation(operation) }
                if error.failure.code == "forbidden" { update(hostID) { $0.mayAnswer = false } }
                feedback = error.failure.code == "stale_request"
                    ? String(localized: "That request changed before your answer reached it. Nothing was answered. Check the card again.")
                    : error.localizedDescription
                await readWatcher(hostID)
            } catch {
                guard generations[hostID] == epoch else { return }
                if let token = claimReceipt(operation.id, over: epoch) { await followReceipt(operation, on: connection, epoch: epoch, token: token) }
            }
            if generations[hostID] == epoch, pending.contains(where: { $0.id == operation.id }) {
                operationFeedback(String(localized: "Your answer isn’t confirmed. Check the thread before you answer again. Nothing was resent."), operations: [operation.id])
            }
        } catch { feedback = error.localizedDescription }
    }

    // MARK: Stop all

    /// Stop all's first step: what it would stop, for the user to confirm. Nothing is stopped yet.
    func prepareWatcherStop(_ hostID: String) async -> WatcherStopPreview? {
        guard offersWatcherStop(hostID), online(hostID), !watcherStopping.contains(hostID) else { return nil }
        watcherStopping.insert(hostID)
        defer { watcherStopping.remove(hostID) }
        #if DEBUG && os(iOS)
        if isUIFixture { return fixtureWatcherStopPreview(hostID) }
        #endif
        guard let connection = connections[hostID], let epoch = generations[hostID] else { return nil }
        do {
            let reply = try await connection.call(WatcherWire.prepareStop, as: WatcherStopPreviewResult.self)
            guard generations[hostID] == epoch else { return nil }
            switch reply {
            case .ok(let preview): return preview
            case .refused(let refusal): feedback = refusal.message; return nil
            }
        } catch let refusal as HostRefusal {
            feedback = refusal.localizedDescription
        } catch {
            feedback = String(localized: "Stop all couldn’t be checked on \(name(hostID)). Nothing was stopped. Try again.", comment: "Stop all is the name of a button. %@ is the computer's name")
        }
        return nil
    }
    /// Stops what the user confirmed: only threads Watcher started that it still works with. Each thread's result is said;
    /// nothing is tried again on its own. The computer keeps what Stop all did under its request's ID for a few minutes,
    /// so a lost acknowledgement reads that receipt rather than leave the outcome unsaid.
    func confirmWatcherStop(_ preview: WatcherStopPreview, on hostID: String) async {
        guard offersWatcherStop(hostID), online(hostID), !watcherStopping.contains(hostID) else { return }
        watcherStopping.insert(hostID)
        defer { watcherStopping.remove(hostID) }
        let titles = Dictionary(preview.targets.map { (ThreadRef(hostID: $0.hostId, threadID: $0.threadId).id, $0.title) }, uniquingKeysWith: { first, _ in first })
        #if DEBUG && os(iOS)
        if isUIFixture { stopFixtureWatcher(preview, on: hostID, titles: titles); return }
        #endif
        guard let connection = connections[hostID], let epoch = generations[hostID] else { return }
        let request = WatcherStopRequest(id: UUID().uuidString.lowercased(), titles: titles)
        watcherStops[hostID] = request
        do {
            let reply = try await connection.call(WatcherWire.stop(confirmationID: preview.confirmationId), as: WatcherStopResult.self, id: request.id)
            // Over a connection that has since changed, the outcome is read from the receipt once the computer is back.
            guard generations[hostID] == epoch else { return }
            watcherStops[hostID] = nil
            switch reply {
            case .ok(let state, let results):
                applyWatcher(state, from: hostID)
                feedback = WatcherWords.stopped(results, titles: titles)
            case .refused(let refusal):
                feedback = refusal.message
            }
        } catch let refusal as HostRefusal {
            if watcherStops[hostID]?.id == request.id { watcherStops[hostID] = nil }
            feedback = refusal.localizedDescription
        } catch {
            // Said until its receipt says more; a connection that is gone reads it once the computer is back.
            feedback = Self.watcherStopUnconfirmed
            await recoverWatcherStop(hostID)
        }
    }
    static let watcherStopUnconfirmed = String(localized: "Stop all isn’t confirmed. Check Watched before you stop anything again.", comment: "Stop all is the name of a button; Watched is the name of a section of the Watcher tab")
    /// Reads what a Stop all whose acknowledgement was lost did, from the receipt its computer keeps under the request's
    /// ID, then reads Watcher's page again. Still being carried out, or not read, it is kept and read again once the
    /// computer is reached again. Nothing is stopped again.
    func recoverWatcherStop(_ hostID: String) async {
        guard let request = watcherStops[hostID], online(hostID), let connection = connections[hostID], let epoch = generations[hostID] else { return }
        // One read of a Stop all receipt at a time on each connection to a computer. A read over a newer connection runs,
        // since one over an older connection stops at its next read.
        guard watcherStopRecoveries[hostID] != epoch else { return }
        watcherStopRecoveries[hostID] = epoch
        defer { if watcherStopRecoveries[hostID] == epoch { watcherStopRecoveries[hostID] = nil } }
        let marked = watcherStopping.insert(hostID).inserted
        defer { if marked { watcherStopping.remove(hostID) } }
        var receipt: Receipt?
        for read in 1...Self.receiptReads {
            do { receipt = try await connection.call(["op": .string("receipt"), "commandId": .string(request.id)], as: Receipt.self) }
            catch { receipt = nil; break }
            guard generations[hostID] == epoch, watcherStops[hostID]?.id == request.id else { return }
            guard receipt?.stillWorking == true, read < Self.receiptReads else { break }
            do { try await receiptSleep(Self.receiptInterval) } catch { return }
        }
        guard generations[hostID] == epoch, watcherStops[hostID]?.id == request.id else { return }
        if let receipt, !receipt.stillWorking {
            // What it did, what the computer refused, or that the computer doesn't know it: settled either way.
            watcherStops[hostID] = nil
            switch receipt.watcherStop {
            case .ok(let results)?: feedback = WatcherWords.stopped(results, titles: request.titles)
            case .refused(let refusal)?: feedback = refusal.message
            case nil: feedback = Self.watcherStopUnconfirmed
            }
        } else {
            feedback = Self.watcherStopUnconfirmed
        }
        await readWatcher(hostID)
    }
}

// What Watcher may do without asking, and the threads it watches (ADR-0073, amended October 13, 2026; Zach's picks:
// control A, mark B, watch B). A computer that offers `watcher-phone-manage` takes these from this iPhone and checks each
// one again: a mode that lets Watcher act without asking needs this iPhone's Can answer there, and watching needs only
// the pairing. None of it answers anything. Each change has its own request ID, so a lost acknowledgement reads what the
// computer did under it; nothing is sent again on its own.
extension AppModel {
    static let watcherManageFeature = WatcherWire.manageFeature
    /// Where `watcherManaging` marks a change to Watcher's permissions on a computer, to a thread's watch, and the
    /// removal of a follow-up waiting for Watcher.
    static func permissionKey(_ hostID: String) -> String { "permission/" + hostID }
    static func watchKey(_ ref: ThreadRef) -> String { "watch/" + ref.id }
    static func followupKey(_ hostID: String, _ itemID: String) -> String { "followup/" + hostID + "/" + itemID }

    /// Whether this computer takes changes to Watcher's permissions and watches from this iPhone. An older one shows its
    /// page without them, and this iPhone offers neither.
    func offersWatcherManage(_ hostID: String) -> Bool {
        offersWatcher(hostID) && live[hostID]?.features.contains(Self.watcherManageFeature) == true
    }

    // MARK: Watcher's permissions (control A)

    /// What Watcher may do without asking on this computer, as its chip says it: the mode just chosen while the computer
    /// takes it, then the one the computer keeps for Watcher.
    func watcherPermission(_ hostID: String) -> String {
        watcherPermissionPicks[hostID] ?? watcherPage(hostID)?.permission ?? WatcherPermissions.first
    }
    /// The modes Watcher's model offers on this computer, in Sotto's order.
    func watcherPermissionModes(_ hostID: String) -> [String] {
        let current = watcherPage(hostID)?.current
        return WatcherPermissions.offered(current.flatMap { current in live[hostID]?.shell?.host.models?.first { $0.id == current.modelId } })
    }
    /// What is still in force while Watcher's provider hasn't confirmed the mode chosen; nil once it has, and before
    /// Watcher runs, when nothing is.
    func watcherPermissionInForce(_ hostID: String) -> String? {
        guard let current = watcherPage(hostID)?.current, let mode = current.runtimeMode, mode != watcherPermission(hostID) else { return nil }
        return WatcherPermissions.inForce(mode, provider: AgentNames.name(current.provider))
    }
    /// Whether the chip can be pressed now: once Watcher's page is read, while no other change to it is on its way, and
    /// not while Watcher works, as on the desktop.
    func canChangeWatcherPermission(_ hostID: String) -> Bool {
        offersWatcherManage(hostID) && online(hostID) && watcherPage(hostID) != nil && !watcherManaging.contains(Self.permissionKey(hostID))
            && !watcherPermissionFixed(hostID)
    }
    /// Whether Watcher's permissions are fixed now: while its turn runs or a card of its own waits on the user, its
    /// computer refuses a change, so the chip waits too.
    func watcherPermissionFixed(_ hostID: String) -> Bool {
        guard let page = watcherPage(hostID) else { return false }
        return page.current?.status == "running" || page.needsYou.contains { page.isOwn($0) }
    }
    /// Whether this iPhone may choose `mode` there: asking first always, and a mode that lets Watcher act without asking
    /// only under this iPhone's Can answer on that computer, which the computer checks again.
    func mayChooseWatcherPermission(_ mode: String, on hostID: String) -> Bool {
        !WatcherPermissions.grants(mode) || mayAnswer(hostID)
    }
    /// Sets what Watcher may do without asking. The chip shows the choice at once; the computer keeps it for Watcher, and
    /// a new Watcher starts on it. Refused, the chip goes back and the computer's words say why.
    func setWatcherPermission(_ mode: String, on hostID: String) async {
        guard canChangeWatcherPermission(hostID), mode != watcherPermission(hostID), mayChooseWatcherPermission(mode, on: hostID),
              watcherPermissionModes(hostID).contains(mode), let operation = try? WatcherWire.setPermission(runtimeMode: mode) else { return }
        let key = Self.permissionKey(hostID)
        watcherManaging.insert(key)
        watcherPermissionPicks[hostID] = mode
        defer { watcherManaging.remove(key); watcherPermissionPicks[hostID] = nil }
        #if DEBUG && os(iOS)
        if isUIFixture { await setFixtureWatcherPermission(mode, on: hostID); return }
        #endif
        _ = await manageWatcher(operation, on: hostID, unconfirmed: WatcherWords.permissionUnconfirmed(name(hostID)))
    }

    // MARK: Watching (watch B)

    /// The computer whose Watcher takes Watch or Stop watching for this thread, or nil where none can: the one that
    /// watches it; otherwise the thread's own computer when it runs Watcher, then the Watcher tab's. Watcher's own thread
    /// is never offered.
    func watchHost(for ref: ThreadRef) -> String? {
        if computers.contains(where: { watcherPage($0.hostID)?.ownRef == ref }) { return nil }
        if let watching = computers.first(where: { watcherSummary($0.hostID)?.watched.contains(ref.id) == true })?.hostID {
            return offersWatcherManage(watching) ? watching : nil
        }
        if offersWatcherManage(ref.hostID) { return ref.hostID }
        return watcherHostID.flatMap { offersWatcherManage($0) ? $0 : nil }
    }
    /// Whether Watch or Stop watching can be pressed for this thread now.
    func canChangeWatch(_ ref: ThreadRef) -> Bool {
        guard let host = watchHost(for: ref) else { return false }
        return online(host) && !watcherManaging.contains(Self.watchKey(ref))
    }
    /// Whether a Watch or Stop watching press for this thread is on its way.
    func changingWatch(_ ref: ThreadRef) -> Bool { watcherManaging.contains(Self.watchKey(ref)) }
    /// What a watched thread's reply box says, or nil for one Watcher doesn't watch: under a standing watch, which lasts
    /// until the user stops it, that Watcher keeps it going, or only steers while the user's own turn runs; watched only for a
    /// Watcher request, or on a computer that keeps no standing watches, that a send there takes it over, as before.
    func watchedLine(_ ref: ThreadRef) -> String? {
        guard let host = computers.first(where: { watcherSummary($0.hostID)?.watched.contains(ref.id) == true })?.hostID,
              let summary = watcherSummary(host) else { return nil }
        guard offersWatcherManage(host), summary.standing.contains(ref.id) else { return WatchedWords.takeover }
        return summary.paused.contains(ref.id) ? WatchedWords.paused : WatchedWords.standing
    }
    /// The threads this iPhone lists that Watcher could be given to watch, in the order Threads shows them: not settled,
    /// not watched, on computers reached now, and never a Watcher's own thread.
    var watchableThreads: [HostedThread] {
        let groups = focusThreads()
        return (groups.questions + groups.working + groups.recent).filter { row in
            row.reachable && !watchedByWatcher(row.ref) && watchHost(for: row.ref) != nil
        }
    }
    /// Watches the thread, or stops watching it, through the computer that runs Watcher. It asks nothing first; what it
    /// did is said with Undo for a few seconds. Watching lasts until the user stops it, with no limit on how many. A
    /// refusal is said in the computer's own words, and an answer lost on the way is read from its receipt.
    /// `recorded` names the computer whose Watcher took an earlier press, for Undo to go back to it, never to another.
    func setWatched(_ ref: ThreadRef, _ watched: Bool, title: String? = nil, on recorded: String? = nil) async {
        guard let host = recorded ?? watchHost(for: ref), offersWatcherManage(host), online(host),
              !watcherManaging.contains(Self.watchKey(ref)), watchedByWatcher(ref) != watched else { return }
        let key = Self.watchKey(ref)
        watcherManaging.insert(key)
        defer { watcherManaging.remove(key) }
        let named = title ?? thread(ref)?.title ?? watcherPage(host)?.watchedThreads.first { $0.target.ref == ref }?.title
            ?? String(localized: "this thread", comment: "Stands in for a thread's title in a sentence when the title isn't known")
        let target = WatcherTarget(hostId: ref.hostID, threadId: ref.threadID)
        let notice = WatchNotice(id: UUID(), hostID: host, target: ref, title: named, watched: watched)
        #if DEBUG && os(iOS)
        if isUIFixture { await watchFixtureThread(ref, watched, title: named, on: host); showWatchNotice(notice); return }
        #endif
        let operation = watched ? WatcherWire.watch(target: target) : WatcherWire.unwatch(target: target)
        let outcome = await manageWatcher(operation, on: host, unconfirmed: WatcherWords.watchUnconfirmed(named, watched: watched, computer: name(host)))
        if outcome == .applied { showWatchNotice(notice) }
    }
    // MARK: What goes next (#1229)

    /// Whether Remove can be pressed for a follow-up waiting for Watcher: one that hasn't started on its way, on a
    /// computer that takes the removal, while no other removal of it is on its way.
    func canRemoveWatcherFollowup(_ item: WatcherPage.Followup, on hostID: String) -> Bool {
        offersWatcherSteer(hostID) && online(hostID) && ["queued", "paused", "failed"].contains(item.status)
            && !watcherManaging.contains(Self.followupKey(hostID, item.itemId))
    }
    /// Takes a follow-up out of Watcher's queue before it goes, through the computer that runs Watcher. Nothing is asked
    /// first: the line leaves the page the computer sends back. A refusal is said in the computer's own words, and an
    /// answer lost on the way is read from its receipt; nothing is sent again on its own.
    func removeWatcherFollowup(_ item: WatcherPage.Followup, on hostID: String) async {
        guard canRemoveWatcherFollowup(item, on: hostID), let target = watcherPage(hostID)?.current?.target else { return }
        let key = Self.followupKey(hostID, item.itemId)
        watcherManaging.insert(key)
        defer { watcherManaging.remove(key) }
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        _ = await manageWatcher(WatcherWire.removeFollowup(target: target, itemID: item.itemId), on: hostID,
                                unconfirmed: WatcherWords.removeUnconfirmed(name(hostID)))
    }

    /// Undo: the press taken back, as a press of its own the other way, on the computer whose Watcher took it. If the
    /// Watcher tab has moved to another computer since, Undo still goes to that one, never to the newly chosen one.
    func undoWatch(_ notice: WatchNotice) async {
        dismissWatchNotice(notice.id)
        await setWatched(notice.target, !notice.watched, title: notice.title, on: notice.hostID)
    }
    func dismissWatchNotice(_ id: UUID) {
        if watchNotice?.id == id { watchNotice = nil }
    }
    /// Says what a press did for eight seconds, long enough to reach Undo; a newer press replaces it.
    private func showWatchNotice(_ notice: WatchNotice) {
        watchNotice = notice
        watchNoticeDismissal?.cancel()
        watchNoticeDismissal = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }
            self?.dismissWatchNotice(notice.id)
        }
    }

    // MARK: Carrying a change

    enum WatcherManageOutcome: Equatable { case applied, refused, unconfirmed }
    /// Sends one change under its own request ID and shows the page that comes back. A refusal says why in the computer's
    /// words. An acknowledgement lost on the way reads that request's receipt, and then the page.
    private func manageWatcher(_ operation: [String: JSONValue], on hostID: String, unconfirmed: String) async -> WatcherManageOutcome {
        guard let connection = connections[hostID], let epoch = generations[hostID] else {
            feedback = String(localized: "Sotto can’t reach \(name(hostID)) now. Nothing changed.", comment: "%@ is the computer's name")
            return .refused
        }
        let id = UUID().uuidString.lowercased()
        do {
            switch try await connection.call(operation, as: WatcherPhoneResult.self, id: id) {
            case .ok(let state):
                // A page older than the one shown is left unshown; the change took either way.
                applyWatcher(state, from: hostID)
                return .applied
            case .refused(let refusal):
                feedback = refusal.message
                return .refused
            }
        } catch let refusal as HostRefusal {
            feedback = refusal.localizedDescription
            return .refused
        } catch {
            return await recoverWatcherManage(id, on: hostID, over: connection, epoch: epoch, unconfirmed: unconfirmed)
        }
    }
    /// Reads what the computer did with a change whose acknowledgement was lost, from the receipt it keeps under the
    /// request's ID for a few minutes, then reads Watcher's page. A receipt it no longer has, or one that can't be read,
    /// leaves the change unconfirmed and says so; the page shows how things stand.
    private func recoverWatcherManage(_ id: String, on hostID: String, over connection: HostConnection, epoch: UUID,
                                      unconfirmed: String) async -> WatcherManageOutcome {
        var receipt: Receipt?
        if generations[hostID] == epoch {
            for read in 1...Self.receiptReads {
                do { receipt = try await connection.call(["op": .string("receipt"), "commandId": .string(id)], as: Receipt.self) }
                catch { receipt = nil; break }
                guard generations[hostID] == epoch, receipt?.stillWorking == true, read < Self.receiptReads else { break }
                do { try await receiptSleep(Self.receiptInterval) } catch { break }
            }
        }
        var outcome = WatcherManageOutcome.unconfirmed
        if generations[hostID] == epoch, let receipt, !receipt.stillWorking {
            switch receipt.watcherManage {
            case .ok?: outcome = .applied
            case .refused(let refusal)?: feedback = refusal.message; outcome = .refused
            case nil: feedback = unconfirmed
            }
        } else {
            feedback = unconfirmed
        }
        await readWatcher(hostID)
        return outcome
    }
}

/// Whether a card in Watcher's page can be answered from here.
enum WatcherCardRoute: Equatable {
    /// Answered at this place, with the request as its computer holds it now.
    case answer(RequestPlace, AgentRequest)
    /// Not answered from here now, and why, in a sentence.
    case note(String)
}

/// Where a waiting request lives, and so where its answer goes: its own thread, on its own computer, or a card in
/// Watcher's page on the computer that runs Watcher (4B). Either way the answer is the user's own, to the thread that asked.
enum RequestPlace: Equatable {
    case thread(ThreadRef)
    /// A card for `target`, a thread on `hostID`, the computer that runs Watcher.
    case watcher(hostID: String, target: ThreadRef)
    /// The computer this iPhone sends the answer to.
    var hostID: String {
        switch self {
        case .thread(let ref): return ref.hostID
        case .watcher(let hostID, _): return hostID
        }
    }
    /// The thread that asked.
    var asker: ThreadRef {
        switch self {
        case .thread(let ref): return ref
        case .watcher(_, let target): return target
        }
    }
}

// The request sheet reads and answers a request wherever it waits.
extension AppModel {
    /// The request as its computer holds it now; nil once it is answered or replaced.
    func waitingRequest(_ id: String, at place: RequestPlace) -> AgentRequest? {
        switch place {
        case .thread(let ref): return thread(ref)?.requests.first { $0.id == id }
        case .watcher(let hostID, let target): return watcherPage(hostID)?.card(target, requestID: id)?.request
        }
    }
    /// The asking thread's title and provider.
    func requestOwner(_ place: RequestPlace) -> (title: String, providerID: String?)? {
        switch place {
        case .thread(let ref): return thread(ref).map { ($0.title, $0.providerId) }
        case .watcher(let hostID, let target):
            guard let page = watcherPage(hostID), let card = page.needsYou.first(where: { $0.target.ref == target }) else { return nil }
            return (page.isOwn(card) ? "Watcher" : card.title, card.provider)
        }
    }
    func mayAnswer(at place: RequestPlace) -> Bool {
        switch place {
        case .thread(let ref): return mayAnswer(ref.hostID)
        case .watcher(let hostID, let target):
            return mayAnswer(hostID) && target.hostID == hostID
                && watcherPage(hostID)?.needsYou.contains { $0.target.ref == target && $0.mayAnswer } == true
        }
    }
    func canAnswer(_ request: AgentRequest, at place: RequestPlace) -> Bool {
        switch place {
        case .thread(let ref): return canAnswer(request, in: ref)
        case .watcher(let hostID, let target):
            guard let card = watcherPage(hostID)?.card(target, requestID: request.id), card.request.asksTheSame(as: request) else { return false }
            return canAnswerWatcherCard(card, on: hostID)
        }
    }
    func answer(_ request: AgentRequest, at place: RequestPlace, choice: String? = nil, text: String = "", answers: [String: QuestionAnswer] = [:]) async {
        switch place {
        case .thread(let ref): await answer(request, in: ref, choice: choice, text: text, answers: answers)
        case .watcher(let hostID, let target):
            guard let card = watcherPage(hostID)?.card(target, requestID: request.id), card.request.asksTheSame(as: request) else { return }
            await answerWatcherCard(card, on: hostID, choice: choice, text: text, answers: answers)
        }
    }
    /// The answer this iPhone sent for the request, while its computer hasn't confirmed it.
    func answerMarker(_ requestID: String, at place: RequestPlace) -> PendingOperation? {
        switch place {
        case .thread(let ref): return pending(for: ref).first { $0.kind == "answer" && $0.requestID == requestID }
        case .watcher(let hostID, let target):
            return scoped(hostID).first { $0.kind == "watcher-answer" && $0.threadID == target.threadID && $0.requestID == requestID }
        }
    }
    /// Whether anything this iPhone sent there is still unconfirmed.
    func hasPending(at place: RequestPlace) -> Bool {
        switch place {
        case .thread(let ref): return !pending(for: ref).isEmpty
        case .watcher(let hostID, let target): return scoped(hostID).contains { $0.kind == "watcher-answer" && $0.threadID == target.threadID }
        }
    }
}

/// A computer step 1 of adding found at a private address, with the health it answered.
struct FoundHost: Equatable {
    let endpoint: HostEndpoint; let health: Health
    /// The computer's own name, or its name on the tailnet from a host that sends none.
    var name: String { health.computerName ?? endpoint.machine }
}

/// A Stop all this iPhone confirmed: the request's ID, under which its computer keeps what it did for a few minutes, and
/// the confirmed threads' titles, by `ThreadRef.id`, to say it with.
struct WatcherStopRequest: Sendable {
    let id: String
    let titles: [String: String]
}

/// What this iPhone knows about one paired computer while the app runs. Nothing here is saved. Equatable, so a state
/// that changes nothing is never published: a working thread's computer sends its shell up to twenty times a second,
/// and most of those change nothing this iPhone reads.
struct Live: Equatable {
    var status = ComputerStatus.connecting
    var shell: Shell?
    var mayAnswer = false
    var features: [String] = []
    /// Why the last connection ended, for the computer's own page.
    var problem: String?
    /// What the rest of the app reads of Watcher's page, from a computer that runs Watcher and offers it to this iPhone
    /// (`watcher-phone`). The page itself is in `WatcherStore`.
    var watcherSummary: WatcherSummary?
}

/// Where a photo comes from: a name for it and its original bytes, read when its turn comes.
struct PhotoSource: Sendable {
    let name: String
    let load: @Sendable () async throws -> Data
}

/// A reply box that takes photos: a thread's, or Watcher's on one computer. Each keeps its own photos, under its own key,
/// so Watcher's box and its thread's never share them.
enum PhotoBox: Hashable {
    case thread(ThreadRef)
    case watcher(hostID: String)
    var hostID: String {
        switch self {
        case .thread(let ref): return ref.hostID
        case .watcher(let hostID): return hostID
        }
    }
    /// The box's key in the model's maps: a thread's `ThreadRef.id`, or the key Watcher's words live under.
    var id: String {
        switch self {
        case .thread(let ref): return ref.id
        case .watcher(let hostID): return hostID + "/watcher"
        }
    }
    /// How many photos the box takes, in the words its notices use, each a whole sentence so a language words it whole.
    var photoLimitWords: String {
        let limit = PhotoLimits.count
        if case .watcher = self {
            return limit == 1 ? String(localized: "A message to Watcher can carry 1 photo.")
                : String(localized: "A message to Watcher can carry \(limit) photos.")
        }
        return limit == 1 ? String(localized: "A reply can carry 1 photo.") : String(localized: "A reply can carry \(limit) photos.")
    }
    /// The same, when only some of the photos chosen fitted.
    var photoLimitOthersWords: String {
        let limit = PhotoLimits.count
        if case .watcher = self {
            return limit == 1 ? String(localized: "A message to Watcher can carry 1 photo. The others weren’t added.")
                : String(localized: "A message to Watcher can carry \(limit) photos. The others weren’t added.")
        }
        return limit == 1 ? String(localized: "A reply can carry 1 photo. The others weren’t added.")
            : String(localized: "A reply can carry \(limit) photos. The others weren’t added.")
    }
    /// Why a photo that would take the box's message past the limit wasn't added.
    var photosTooLargeWords: String {
        if case .watcher = self {
            return String(localized: "These photos would take the message over 20 MB, so this one wasn’t added. Send these first, or remove one.",
                          comment: "The message is one to Watcher")
        }
        return String(localized: "These photos would take the reply over 20 MB, so this one wasn’t added. Send these first, or remove one.")
    }
}

/// A photo in a reply box. It is prepared on this iPhone, then staged on the box's computer,
/// and stays in memory until its message is sent or the photo is removed. Nothing is written to disk.
struct DraftPhoto: Identifiable {
    let id = UUID()
    var prepared: PreparedPhoto?
    var staged: StagedImage?
    var stagedAt: Date?
    /// The connection generation it was staged over. A computer reached again may have restarted and let it go.
    var stagedGeneration: UUID?
    var staging = false
    var preparing: Bool { prepared == nil }
    /// Not yet on the computer, on it long enough that the computer may have let it go, or staged over a
    /// connection that has since ended.
    func needsStaging(generation: UUID?) -> Bool {
        staged == nil || stagedGeneration != generation || stagedAt.map { Photos.needsRestaging(stagedAt: $0) } != false
    }
}

/// Where a file comes from (ADR-0131): its name, the size the Files app gives for it, when it gives one, and its bytes,
/// read when its turn comes.
struct FileSource: Sendable {
    let name: String
    let sizeBytes: Int?
    let load: @Sendable () async throws -> Data
}

/// A file in a thread's reply box. It is read into memory on this iPhone, then staged on the thread's computer in parts,
/// and stays in memory until its reply is sent or the file is removed. Nothing is written to disk.
struct DraftFile: Identifiable {
    let id = UUID()
    let name: String
    let mimeType: String
    /// The size the Files app gave until it is read, then its own.
    var sizeBytes: Int
    var bytes: Data?
    var digest: String?
    var staged: StagedFile?
    var stagedAt: Date?
    var stagedGeneration: UUID?
    /// The share of it its computer has, from 0 to 1, while it is being sent there.
    var progress: Double?
    var reading: Bool { bytes == nil }
    func needsStaging(generation: UUID?) -> Bool {
        staged == nil || stagedGeneration != generation || stagedAt.map { Photos.needsRestaging(stagedAt: $0) } != false
    }
}

/// What came of asking a thread's computer for a sent file to open.
enum SentFileOutcome: Equatable {
    case file(name: String, data: Data)
    /// The computer no longer keeps it.
    case notKept
    case failed
}

/// A photo's original on its way: whichever of its arrival, its time limit or its removal comes first decides,
/// and the others are ignored.
@MainActor private final class PhotoLoad {
    var continuation: CheckedContinuation<Data, Error>?
    var tasks: [Task<Void, Never>] = []
    func finish(_ result: Result<Data, Error>) {
        continuation?.resume(with: result); continuation = nil
        tasks.forEach { $0.cancel() }; tasks = []
    }
}

/// Whether iOS lets Sotto show alerts.
enum AlertPermission: Equatable { case undecided, allowed, denied }

/// Shows local alerts (ADR-0051): only on this iPhone, with no push service. The app hands the model iOS's
/// notification centre; the model's tests hand it a fake.
@MainActor protocol AlertPosting: AnyObject {
    func permission() async -> AlertPermission
    /// Asks iOS, which asks the user the first time. True when alerts may be shown.
    func requestPermission() async -> Bool
    func post(_ alert: ThreadAlert, sound: Bool)
}

/// The reply boxes' words, by `ThreadRef.id`. A store of its own so that typing publishes here and not on `AppModel`,
/// which nearly every view watches: with the words on the model, each keystroke made the thread page, its conversation
/// and the Threads list underneath it evaluate their bodies again.
@MainActor final class DraftStore: ObservableObject {
    @Published var text: [String: String] = [:]
}

/// The open thread's history. A store of its own for the same reason: a working thread's message arrives a few words at
/// a time, up to twenty times a second, and only the conversation and the Working now cards watch it.
@MainActor final class DetailStore: ObservableObject {
    @Published var detail: ThreadDetail?
    /// The open thread as it was last read, kept on screen while it is read again: after its computer reconnects, the
    /// app comes back, or the user returns to the thread. A fresh copy replaces it.
    @Published var held: HeldDetail?
}

/// Watcher's pages, by computer. A store of its own for the same reason: while Watcher answers, its conversation changes
/// with every shell its computer sends, and only the Watcher tab reads it. The tab's dot and badge and the owl on watched
/// threads read a summary on the model, which changes far less often.
@MainActor final class WatcherStore: ObservableObject {
    @Published var pages: [String: WatcherPage] = [:]
    /// The starts each computer's machines were last read for, so a placement is read for once however often the tab opens.
    var machinesReadFor: [String: String] = [:]
}

/// A thread's history as it was last read, and the thread it belongs to.
struct HeldDetail {
    let ref: ThreadRef
    let detail: ThreadDetail
}

/// Every paired computer, each with its own connection, session and state. A computer that can't be
/// reached, or fails, never holds up the others. Everything that names a thread names its computer too.
@MainActor final class AppModel: ObservableObject {
    private static let requestNoLongerWaiting = String(localized: "That request is no longer waiting.")
    private static let markersUnreadable = String(localized: "Saved unconfirmed actions could not be read. Check your threads before sending again. Nothing was resent.")
    private static func pairingWarning(_ count: Int) -> String {
        count == 1 ? String(localized: "1 saved computer needs pairing again.") : String(localized: "\(count) saved computers need pairing again.")
    }
    /// In the order they were added. Credentials live in the Keychain, one item per host ID.
    @Published private(set) var computers: [SavedComputer] = [] { didSet { listed = Listed() } }
    @Published private(set) var live: [String: Live] = [:] { didSet { listed = Listed() } }
    @Published private(set) var selected: ThreadRef?
    /// What the thread lists work out from `computers` and `live`, kept until either changes. The Threads list, the tab
    /// bar and a thread's top bar each ask on every redraw, and nearly every redraw comes from something else.
    private var listed = Listed()
    private struct Listed {
        struct GroupKey: Hashable { let show: ComputerFilter; let query: String; let opened: ThreadRef?; let holding: Set<String> }
        var groups: [GroupKey: FocusThreads] = [:]
        var refs: Set<String>?
        var badge: (opened: ThreadRef?, count: Int)?
        var agents: [ThreadRef: AgentsCount?] = [:]
    }
    @Published private(set) var pending: [PendingOperation] = []
    /// Finding or pairing a computer.
    @Published private(set) var working = false
    @Published private(set) var storageReady = false
    /// The computer being removed, while its pairing is revoked.
    @Published private(set) var removing: String?
    /// What just happened on the tabs.
    @Published var feedback: String? { didSet { feedbackOperations = [] } }
    /// Answers whose own receipt the computer confirmed, as `host/thread/request`, so a Threads card can say Answered
    /// only for those. An answer whose request left without that receipt is not in here.
    @Published private(set) var confirmedAnswers: Set<String> = []
    /// Whether the computer confirmed this iPhone's answer to a request.
    func answerConfirmed(_ requestID: String, in ref: ThreadRef) -> Bool {
        confirmedAnswers.contains(ref.hostID + "/" + ref.threadID + "/" + requestID)
    }
    private var feedbackOperations: Set<String> = []
    /// More than one check can await the same computer; keep markers until every check returns.
    private var deliveryChecks: [String: Int] = [:]
    /// What went wrong while finding or pairing a computer.
    @Published var pairFeedback: String?
    /// Unsent replies, by `ThreadRef.id`. They live in `draftStore`, which publishes on its own: only the reply box and
    /// what depends on it watch that, so a keystroke redraws the reply box, not every view that watches the model.
    let draftStore = DraftStore()
    var drafts: [String: String] {
        get { draftStore.text }
        set { draftStore.text = newValue; publishOnModelIfComparing() }
    }
    /// The open thread's history, in `detailStore`, which publishes on its own in the same way.
    let detailStore = DetailStore()
    /// Watcher's pages, in `watcherStore`, which publishes on its own in the same way.
    let watcherStore = WatcherStore()
    private var openDetail: ThreadDetail? {
        get { detailStore.detail }
        set { detailStore.detail = newValue; publishOnModelIfComparing() }
    }
    /// Why the open thread could not be read. It changes rarely, so it stays on the model. Every new revision clears it,
    /// so a revision sets it only when it holds something, and an unchanged nil publishes nothing.
    @Published private(set) var detailProblem: String?
    #if DEBUG && os(iOS)
    /// The measuring journeys' comparison (`--ui-publish-everything`): every change published on the whole model, as the
    /// app did before the draft and detail stores, and before a computer's unchanged state was left unpublished.
    private static let publishesEverything = ProcessInfo.processInfo.arguments.contains("--ui-publish-everything")
    #else
    private static let publishesEverything = false
    #endif
    /// Called after a store publishes a change. Only the comparison publishes it on the model too.
    private func publishOnModelIfComparing() {
        if Self.publishesEverything { objectWillChange.send() }
    }
    @Published private(set) var submitted: [String: String] = [:]
    @Published private(set) var failedReplies: [String: String] = [:]
    /// Photos in each reply box, by `PhotoBox.id`, in the order they were chosen.
    @Published private(set) var draftPhotos: [String: [DraftPhoto]] = [:]
    /// Why the last photo chosen for a reply box wasn't added, by `PhotoBox.id`.
    @Published var photoNotices: [String: String] = [:]
    /// The photos of a reply on its way, by operation ID, and of a refused reply, by `ThreadRef.id`.
    @Published private(set) var submittedPhotos: [String: [DraftPhoto]] = [:]
    @Published private(set) var failedPhotos: [String: [DraftPhoto]] = [:]
    /// Files in each thread's reply box, by `ThreadRef.id`, in the order they were chosen (ADR-0131); and those of a reply
    /// on its way, by operation ID, and of a refused reply, by `ThreadRef.id`. Their notices are the photos'.
    @Published private(set) var draftFiles: [String: [DraftFile]] = [:]
    @Published private(set) var submittedFiles: [String: [DraftFile]] = [:]
    @Published private(set) var failedFiles: [String: [DraftFile]] = [:]
    /// Reply boxes, by `PhotoBox.id`, whose message is having its photos staged again before it is sent, and Watcher's
    /// until its computer answers. A second press finds it here.
    @Published private(set) var preparingSends: Set<String> = []
    /// Replies, answers and stops on their way: the computer hasn't answered yet, or says it is still
    /// carrying the command out. They read as sending, not as unconfirmed.
    /// Commands being dispatched, each with the connection generation it went out on.
    @Published private var dispatchingOperations: [String: UUID?] = [:]
    /// Who is reading each command's receipt, and over which connection. A newer connection takes over from an
    /// older one, which then stops without touching what the newer one shows.
    @Published private var receiptFollowers: [String: ReceiptFollower] = [:]
    private struct ReceiptFollower { let token: UUID; let generation: UUID? }
    /// The kinds that read as sending. A thread or project creation keeps its own sheet and its own wait.
    private static let sendingKinds: Set<String> = ["reply", "queue", "answer", "watcher-answer", "interrupt", "steer", "remove", "compact", "babysit", "stop-babysitting"]
    /// The kinds whose refusal the computer says only in its shell's error, said here as feedback.
    private static let queueActionKinds: Set<String> = ["steer", "remove", "compact", "babysit", "stop-babysitting"]
    /// A receipt the computer says is still being carried out is read again this often, this many times: about ten minutes.
    private static let receiptInterval: UInt64 = 2_000_000_000
    private static let receiptReads = 300
    private var stagingTasks: [UUID: Task<Bool, Never>] = [:]
    private var fileStagingTasks: [UUID: Task<Bool, Never>] = [:]
    /// Files are read one at a time, so several large files are never read at once.
    private var fileWork: Task<Void, Never>?
    /// The last large request queued for each computer, which refuses a second while one is on its way.
    private var largeRequests: [String: Task<Void, Never>] = [:]
    /// Photos are prepared one at a time, so several large photos are never decoded at once.
    private var photoWork: Task<Void, Never>?
    private let preparePhoto: @Sendable (Data, String) async throws -> PreparedPhoto
    /// Waits out how long a photo's original may take to arrive, from iCloud for one not on this iPhone, before it
    /// is left out: two minutes.
    private let photoLoadLimit: @Sendable () async throws -> Void
    private var photoLoads: [UUID: PhotoLoad] = [:]
    /// Hands a sent reply's photos to whatever draws the thread, so it has them before their message arrives.
    var photosSent: (([DraftPhoto], ThreadRef) -> Void)?
    private let receiptSleep: @Sendable (UInt64) async throws -> Void
    /// The computer step 1 of adding found, waiting for its code in step 2.
    @Published private(set) var found: FoundHost?
    /// Whether the Add computer sheet is over the tabs.
    @Published var adding = false
    @Published private(set) var creatingHostID: String?
    @Published var creationFeedback: String?
    /// The computer menu on Threads.
    @Published var show = ComputerFilter.all
    /// A thread whose alert was tapped, for the tabs to open. They set it back to nil once it is open.
    @Published var alertOpened: ThreadRef?
    /// A computer whose Watcher alert was tapped, for the tabs to open the Watcher tab. Set back to nil once it is open.
    @Published var watcherAlertOpened: String?
    /// The computer whose Watcher was last chosen for the Watcher tab, by its alert or the header's menu.
    @Published private var chosenWatcherHost: String?
    /// Words on their way to Watcher, by computer, shown under the conversation until Watcher takes them.
    @Published private(set) var watcherSending: [String: String] = [:]
    /// The photos of the message on its way to Watcher, by computer. Watcher's box stays locked meanwhile, so they go back
    /// in it, with the words, when Watcher refuses them or doesn't confirm them.
    @Published private(set) var watcherSendingPhotos: [String: [DraftPhoto]] = [:]
    /// Words that didn't reach Watcher, or that it didn't confirm, while newer words were in its box, by computer, oldest
    /// first. Each is offered back under the conversation, to go back in the box once it is empty. Nothing here is sent.
    @Published private(set) var watcherSetAside: [String: [WatcherSetAside]] = [:]
    /// Why each computer's Watcher page couldn't be read, until a read works.
    @Published private(set) var watcherReadProblems: [String: String] = [:]
    /// A Stop all whose outcome its computer hasn't told this iPhone yet, by computer.
    private var watcherStops: [String: WatcherStopRequest] = [:]
    /// The connection each computer's Stop all receipt is being read over now.
    private var watcherStopRecoveries: [String: UUID] = [:]
    /// Computers whose Stop all is being checked or carried out.
    @Published private(set) var watcherStopping: Set<String> = []
    /// Whether the Watcher tab is on screen, so its own alerts stay quiet there.
    var watcherOnScreen = false
    /// The draft IDs each computer's Watcher box sent with that Watcher hasn't been confirmed to take, with their exact
    /// words: the same words sent again go with the same ID, even after other words, so the computer can't deliver them
    /// twice. Other words get a new one.
    private var watcherDrafts: [String: WatcherDrafts] = [:]
    /// Computers whose page is being read, and ones asked to read again once that read is done.
    private var watcherReads: Set<String> = []
    private var watcherRereads: Set<String> = []
    /// Computers whose machines are being read afresh, and ones asked to read them again once that read is done (#1032).
    private var watcherMachineReads: Set<String> = []
    private var watcherMachineRereads: Set<String> = []
    /// What each computer's Watcher page held when this iPhone last read it, for Watcher's own alerts.
    private var watcherWatches: [String: WatcherWatch] = [:]
    /// Watcher's permissions, by computer, and threads' watches, by thread, being changed until their computer answers
    /// (`AppModel.permissionKey`, `AppModel.watchKey`).
    @Published private(set) var watcherManaging: Set<String> = []
    /// The mode just chosen for Watcher on each computer, shown on its chip while the computer takes it.
    @Published private(set) var watcherPermissionPicks: [String: String] = [:]
    /// What the last Watch or Stop watching press did, said with Undo for a few seconds.
    @Published private(set) var watchNotice: WatchNotice?
    /// Each pull request as this iPhone last read it while running, by computer and pull request, for the chip's dot
    /// (ADR-0102). Kept in memory only, and read again whenever its sheet opens.
    @Published private(set) var pullRequestReads: [String: PullRequestDetail] = [:]
    private var watchNoticeDismissal: Task<Void, Never>?
    /// This iPhone's own preferences: alert switches and new-thread defaults.
    var preferences = PhonePreferences()
    /// Posts local alerts. Nil until the app hands it over.
    var alerts: AlertPosting?
    /// What each computer's thread list held when this iPhone last read it, for alerts. Emptied when a connection
    /// ends, so the first list after connecting is never news.
    private var watches: [String: ThreadWatch] = [:]
    /// Whether the app is on screen now, rather than inactive or in the background.
    private var foreground = false
    private var threadSelectionGeneration = UUID()
    private let keychain: KeychainStore
    private var computerIndexAccount: String? = ComputerStore.indexAccount
    /// Finds and pairs computers; each paired computer gets its own connection.
    private let finder = HostConnection()
    private var connections: [String: HostConnection] = [:]
    private var generations: [String: UUID] = [:]
    private var connecting: Set<String> = [] { didSet { releaseConnectWaiters() } }
    /// Requests to connect a computer that was already connecting, each waiting for that attempt to end.
    private var connectWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var active = false
    private var activationConnection: Task<Void, Never>?
    private var retries: [String: Task<Void, Never>] = [:]
    private var retryAttempts: [String: Int] = [:]
    /// Computers that have been online since they last gave up. A lost connection to one of them is tried again quietly,
    /// about a minute in all; a computer that never connected is tried once. A computer that gives up reads Can't reach
    /// it and waits for the user's Try again or Reconnect: coming back to the app and pulling to refresh leave it alone.
    private var wasOnline: Set<String> = []
    /// Quiet retries after a lost connection, at 1, 2, 4, 8, 16 and 30 seconds, within about a minute of the loss: a
    /// computer that doesn't answer takes ten seconds an attempt, and six of those would double it.
    private static let quietRetries = 6
    private static let quietRetryWindow: TimeInterval = 60
    /// When each computer's quiet retries began.
    private var retryingSince: [String: Date] = [:]
    private let retryJitter: @Sendable () -> Double
    private let retrySleep: @Sendable (UInt64) async throws -> Void
    private var pairGeneration = UUID()
    private var detailVersion = 0
    private var detailReload: Task<Void, Never>?
    private var detailReloadID: UUID?
    private var detailWantedRevision = 0
    private var shellSequences: [String: Int] = [:]
    #if DEBUG && os(iOS)
    /// Simulator journeys use in-memory display data; this code is absent from Release.
    private var isUIFixture = false
    /// The fixture hands a thread's messages over a moment after it opens, as a computer does over the network.
    private var fixtureSlowDetail = false
    /// The reconnecting journey: a moment after a thread opens, its computer loses its connection and is tried again.
    private var fixtureReconnecting = false
    private var fixtureDetails: [String: ThreadDetail] = [:]
    private var fixtureShells: [String: [String: Any]] = [:]
    /// The laptop's Watcher page in the Watcher journeys, as the laptop would send it.
    private var fixtureWatcher: [String: Any]?
    private func loadUIFixture() {
        isUIFixture = true
        if ProcessInfo.processInfo.arguments.contains("--reset-ui-preferences"), let bundle = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: bundle)
        }
        func decode<T: Decodable>(_ type: T.Type, _ object: Any) -> T {
            // Invalid fixed test data should fail loudly in the simulator, never become an empty list.
            try! JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
        }
        let laptop = "11111111-1111-4111-8111-111111111111"
        let studio = "22222222-2222-4222-8222-222222222222"
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--ui-light") {
            UserDefaults.standard.set("light", forKey: PhonePreferenceKey.appearance)
        }
        // The question journey: the working thread asks a question, and the laptop lets this iPhone answer it.
        let asking = arguments.contains("--ui-question-while-reading")
        // The Watcher journeys: the laptop runs Watcher, with two workers of its own and two on the studio Mac. With
        // --ui-watcher-can-answer the laptop lets this iPhone answer; with --ui-watcher-asks Watcher itself is asking.
        let watching = arguments.contains("--ui-watcher")
        let watcherAnswers = watching && arguments.contains("--ui-watcher-can-answer")
        let caps: [String: Bool] = ["submit": false, "interrupt": false, "questions": false, "permissions": false, "projects": true, "threads": true]
        let answeringCaps: [String: Bool] = ["submit": false, "interrupt": false, "questions": true, "permissions": true, "projects": true, "threads": true]
        let rows: [(String, String, String, String, Int)] = [
            ("release", "Choose the release target", "sotto", "idle", 2),
            ("iphone", "Refine the iPhone thread view", "sotto", "running", 6),
            ("wiring", "Clean up the wiring schedule", "panel", "idle", 12),
            ("shortcuts", "Add keyboard shortcuts", "sotto", "idle", 18),
            ("drives", "Compare motor drive options", "panel", "idle", 60),
            ("lighting", "Update the lighting plan", "house", "idle", 1440),
            ("settings", "Simplify the settings screen", "sotto", "idle", 2880),
            ("notes", "Organize the panel notes", "panel", "idle", 4320)
        ]
        let stamp = ISO8601DateFormatter()
        func at(_ secondsAgo: Double) -> String { stamp.string(from: Date().addingTimeInterval(-secondsAgo)) }
        var threads: [String: [[String: Any]]] = [:]
        for (id, title, project, status, minutes) in rows {
            let host = id == "lighting" ? studio : laptop
            let date = stamp.string(from: Date().addingTimeInterval(-Double(minutes * 60)))
            var row: [String: Any] = ["id": id, "hostId": host, "projectId": project, "title": title,
                "providerId": id == "release" || id == "wiring" ? "claude" : "codex", "status": status,
                "requests": [], "summary": ["lastMessageAt": date]]
            if id == "release" {
                row["requests"] = [["id": "release-target", "kind": "question",
                    "text": "Which release should I prepare?", "options": [
                        ["id": "testflight", "label": "TestFlight"], ["id": "desktop", "label": "Desktop"]]],
                    ["id": "release-permission", "kind": "permission", "text": "Allow reading the release checklist?", "options": []]]
            }
            if id == "iphone" {
                // The thread page journeys read this one: its turn's start, its worktree's Git status and a draft
                // pull request for the chips, and in the question journey a question waiting in it.
                let summary: [String: Any] = ["lastMessageAt": date, "runningTurnStartedAt": at(12 * 60)]
                row["summary"] = summary
                row["worktree"] = Self.fixtureWorktree
                if asking { row["requests"] = [Self.fixtureQuestion] }
            }
            if id == "wiring" { row["backgroundWork"] = [["type": "agent"]] }
            // Finished while nothing showed it, so Recent marks it until it is opened (ADR-0046).
            if id == "shortcuts" { row["finishedUnread"] = true }
            if id == "settings" || id == "notes" { row["settledAt"] = date }
            threads[host, default: []].append(row)
            fixtureDetails[host + "/" + id] = decode(ThreadDetail.self, ["threadId": id, "revision": 1,
                "messages": [["id": "prompt", "role": "user", "text": title + ". Keep the changes focused."],
                    ["id": "reply", "role": "assistant", "text": "I have the context and am checking the details. The next update will summarize the changes and anything that needs your attention."]],
                "activities": [["id": "read", "sequence": 1, "kind": "command", "status": "completed", "title": "Read project notes"]]])
        }
        if watching {
            // Watcher's two workers on the laptop: one it started, which asks which account to use, and one it sent a note.
            let login: [String: Any] = ["id": "login", "hostId": laptop, "projectId": "sotto", "title": "Fix login test", "providerId": "claude",
                "status": "running", "requests": [Self.fixtureLoginQuestion], "summary": ["lastMessageAt": at(3 * 60), "runningTurnStartedAt": at(22 * 60)]]
            let notes: [String: Any] = ["id": "notes845", "hostId": laptop, "projectId": "sotto", "title": "Babysit #845 release notes",
                "providerId": "codex", "status": "running",
                "requests": arguments.contains("--ui-watcher-two-cards") ? [Self.fixtureNotesPublish] : [[String: Any]](),
                "summary": ["lastMessageAt": at(5 * 60), "runningTurnStartedAt": at(12 * 60)]]
            threads[laptop, default: []] += [login, notes]
            fixtureDetails[laptop + "/login"] = decode(ThreadDetail.self, ["threadId": "login", "revision": 1, "messages": [
                ["id": "brief", "role": "user", "text": "The login test fails about one run in five. Find out why and make it pass every time.", "createdAt": at(22 * 60)],
                ["id": "found", "role": "assistant", "text": "Overlapping runs share one test account, so one run signs the other out. Which account should it use?", "createdAt": at(3 * 60)]]])
            fixtureDetails[laptop + "/notes845"] = decode(ThreadDetail.self, ["threadId": "notes845", "revision": 1, "messages": [
                ["id": "brief", "role": "user", "text": "Write the release notes for #845 once its checks pass.", "createdAt": at(12 * 60)]]])
        }
        // The Agents journey: the working thread's delegated threads and its provider's agents (ADR-0103).
        let agents = arguments.contains("--ui-agents")
        if agents { addFixtureAgents(to: &threads, laptop: laptop, at: at) }
        // The working thread's own conversation: a review reply in Markdown and a follow-up, with the agent's steps
        // between them by time, the last one still running.
        let conversation: [[String: Any]] = [
            ["id": "ask-review", "role": "user", "text": "Review the frosted window branch against the spec and tell me what’s off.", "createdAt": at(40 * 60)],
            ["id": "review", "role": "assistant", "text": Self.fixtureReview, "createdAt": at(36 * 60)],
            ["id": "ask-fix", "role": "user", "text": "Fix the tooltips first, then the drawer chord.", "createdAt": at(12 * 60)],
            ["id": "update", "role": "assistant", "text": "Still working through the review fixes. The tooltips are done; the drawer’s chord is next.", "createdAt": at(6 * 60)]
        ]
        let opened: [[String: String]] = [["path": "src/renderer/src/agents/TerminalDrawer.tsx", "kind": "read"]]
        let tooltips: [[String: String]] = [["path": "src/renderer/src/agents/terminalTooltips.ts", "kind": "update"]]
        let drawer: [[String: String]] = [["path": "src/renderer/src/agents/TerminalDrawer.tsx", "kind": "update"]]
        let steps: [[String: Any]] = [
            ["id": "think", "sequence": 1, "kind": "reasoning", "status": "completed", "title": "Thought for 12s", "startedAt": at(39 * 60)],
            ["id": "read-drawer", "sequence": 2, "kind": "tool", "status": "completed", "title": "Read", "changes": opened, "startedAt": at(38 * 60 + 30)],
            ["id": "edit-tooltips", "sequence": 3, "kind": "file-change", "status": "completed", "title": "Edited", "changes": tooltips, "startedAt": at(11 * 60)],
            ["id": "edit-drawer", "sequence": 4, "kind": "file-change", "status": "completed", "title": "Edited", "changes": drawer, "startedAt": at(10 * 60)],
            ["id": "typecheck", "sequence": 5, "kind": "command", "status": "completed", "title": "Ran", "command": "npm run typecheck",
             "exitCode": 0, "durationMs": 38_000, "startedAt": at(8 * 60)],
            ["id": "drawer-test", "sequence": 6, "kind": "command", "status": "running", "title": "Running",
             "command": "npm test -- tests/unit/renderer/terminalDrawer.test.ts", "startedAt": at(41)]
        ]
        fixtureDetails[laptop + "/iphone"] = decode(ThreadDetail.self, ["threadId": "iphone", "revision": 2,
            "messages": conversation, "activities": steps])
        // A long conversation of tall replies, for the journey that opens a thread and expects its end on screen at once.
        if arguments.contains("--ui-long-thread") {
            let (longMessages, longSteps) = Self.fixtureLongThread(at)
            fixtureDetails[laptop + "/drives"] = decode(ThreadDetail.self, ["threadId": "drives", "revision": 1,
                "messages": longMessages, "activities": longSteps])
        }
        fixtureSlowDetail = arguments.contains("--ui-slow-detail")
        fixtureReconnecting = arguments.contains("--ui-reconnecting")
        // Watcher's model offers all four modes in the Watcher journeys, as Codex does.
        let modes: [String] = watching ? WatcherPermissions.modes : ["approval-required", "full-access"]
        for (host, name) in [(laptop, "Laptop"), (studio, "Studio Mac")] {
            let answers = (asking || watcherAnswers) && host == laptop
            let hostCaps = answers ? answeringCaps : caps
            let pairing = decode(Pairing.self, ["v": 1, "hostId": host, "clientId": "ui-fixture", "token": "not-a-credential"])
            computers.append(SavedComputer(address: "https://fixture.invalid.ts.net", pairing: pairing, reportedName: name))
            let shellObject: [String: Any] = ["hostId": host, "host": ["hostId": host, "name": name,
                "threads": threads[host] ?? [], "projects": [["id": "sotto", "title": "Sotto", "path": "D:\\Talk to Text Application"],
                    ["id": "panel", "title": "Panel tools", "path": "D:\\Engineering\\Panel tools"], ["id": "house", "title": "House", "path": "D:\\House"]],
                "models": [["id": "fixture-model", "name": "GPT-6.1 Sol", "provider": "Codex", "providerId": "codex", "ready": true,
                    "reasoningEfforts": ["low", "medium", "high"], "defaultReasoningEffort": "high", "runtimeModes": modes]],
                "providers": [["id": "codex", "connection": "connected", "capabilities": hostCaps]], "capabilities": hostCaps]]
            fixtureShells[host] = shellObject
            let shell = decode(Shell.self, shellObject)
            var features = ["host-folders"]
            if watching && host == laptop { features += [Self.watcherFeature, Self.watcherStopFeature, Self.watcherManageFeature] }
            // The pull request journey: the laptop is an Owl computer that offers the pull request sheet and babysitting.
            if arguments.contains("--ui-pull-request") && host == laptop { features += [Self.pullRequestViewFeature, Self.babysitFeature] }
            if agents && host == laptop { features += [AgentsRoster.feature, "subagents", "failure-seen"] }
            live[host] = Live(status: host == laptop ? .online : .unreachable, shell: shell, mayAnswer: answers, features: features)
        }
        if watching {
            var page = Self.fixtureWatcherPage(laptop: laptop, studio: studio, mayAnswer: watcherAnswers,
                                               asks: arguments.contains("--ui-watcher-asks"),
                                               reasoned: !arguments.contains("--ui-watcher-no-reason"), at: at)
            // With --ui-watcher-keeps-writing, Fix login test's question arrives while Watcher writes, and Watcher goes on
            // writing above it (#1277). With --ui-watcher-two-cards too, Babysit #845 release notes asks for a permission
            // under it, which the laptop answers when the journey says so.
            let keepsWriting = arguments.contains("--ui-watcher-keeps-writing")
            var waiting = page["needsYou"]
            if keepsWriting, arguments.contains("--ui-watcher-two-cards"), let cards = waiting as? [[String: Any]] {
                waiting = cards + [Self.fixtureNotesPermission(laptop: laptop, mayAnswer: watcherAnswers)]
            }
            if keepsWriting { page["needsYou"] = [[String: Any]]() }
            // With --ui-watcher-nothing-waits, no card waits on the user, so the bar slides as the user reads (#1288).
            if arguments.contains("--ui-watcher-nothing-waits") { page["needsYou"] = [[String: Any]]() }
            // With --ui-watcher-queued-below, ten of the user's follow-ups wait in Watcher's queue at the page's end, so
            // the conversation has page enough to read down on the largest iPhone with no card waiting, or once one is
            // answered, and the bar has a page to slide away from (#1278).
            if arguments.contains("--ui-watcher-queued-below") {
                page["followups"] = (1...10).map { n -> [String: Any] in
                    ["itemId": "queued-\(n)", "draftId": "queued-draft-\(n)", "text": "Look at #845’s checks again, \(n) of 10",
                     "status": "queued"]
                }
            }
            // With --ui-watcher-many-watched, Watcher watches six more of the fixture's threads, so Watched is taller than
            // the largest iPhone's screen and the bar has a page to slide away from there too (#1278).
            if arguments.contains("--ui-watcher-many-watched") {
                let more: [(String, String, String, String)] = [
                    (laptop, "release", "Choose the release target", "claude"), (laptop, "iphone", "Refine the iPhone thread view", "codex"),
                    (laptop, "wiring", "Clean up the wiring schedule", "claude"), (laptop, "drives", "Compare motor drive options", "codex"),
                    (studio, "lighting", "Update the lighting plan", "codex"), (laptop, "settings", "Simplify the settings screen", "codex")
                ]
                let rows = more.map { host, id, title, provider -> [String: Any] in
                    ["target": ["hostId": host, "threadId": id], "title": title, "provider": provider, "status": "running",
                     "connected": true, "watched": true, "takenOver": false, "backgroundWorkCount": 0]
                }
                page["watchedThreads"] = (page["watchedThreads"] as? [[String: Any]] ?? []) + rows
            }
            fixtureWatcher = page
            showWatcher(decode(WatcherPage.self, page), on: laptop)
            if keepsWriting { keepFixtureWatcherWriting(on: laptop, then: waiting) }
            if arguments.contains("--ui-watcher-two-cards") { answerFixtureNotesWhenAsked(on: laptop) }
        }
        storageReady = true
        if arguments.contains("--ui-streaming") { streamFixture(host: laptop) }
        if arguments.contains("--ui-feedback-request-gone") { feedback = Self.requestNoLongerWaiting }
        if arguments.contains("--ui-feedback-markers-unreadable") { feedback = Self.markersUnreadable }
        if arguments.contains("--ui-feedback-computer-unreadable") { feedback = String(localized: "Recovered the saved computer list.") + " " + Self.pairingWarning(1) }
    }
    /// The streaming journeys: the working thread's update grows by a word every 50 milliseconds, as often as a computer
    /// sends, and each time the computer's thread list comes again unchanged, as it does while a thread streams.
    private func streamFixture(host: String) {
        guard let object = fixtureShells[host],
              let shell = try? JSONDecoder().decode(Shell.self, from: JSONSerialization.data(withJSONObject: object)) else { return }
        let ref = ThreadRef(hostID: host, threadID: "iphone")
        let words = "The drawer’s chord is next, then the tests run again and the branch is ready for review.".split(separator: " ")
        Task { [weak self] in
            var sequence = 0
            while true {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self else { return }
                sequence += 1
                push(.shell(shell), from: host, sequence: sequence)
                guard selected == ref, let detail = openDetail else { continue }
                let delta: [String: Any] = ["threadId": ref.threadID, "baseRevision": detail.revision, "revision": detail.revision + 1,
                                            "messageDeltas": [["id": "update", "appendText": " " + String(words[sequence % words.count])]],
                                            "activityDeltas": [[String: Any]]()]
                guard let change = try? JSONDecoder().decode(ThreadDetailDelta.self, from: JSONSerialization.data(withJSONObject: delta)),
                      let next = detail.applying(change) else { continue }
                openDetail = next; detailVersion += 1
            }
        }
    }
    /// Twelve turns of a question and a long Markdown reply, a command between each, and a last step after the final reply.
    private static func fixtureLongThread(_ at: (Double) -> String) -> ([[String: Any]], [[String: Any]]) {
        var messages: [[String: Any]] = []
        var steps: [[String: Any]] = []
        for turn in 0..<12 {
            let base = Double(12 - turn) * 600
            messages.append(["id": "ask-\(turn)", "role": "user", "createdAt": at(base),
                             "text": "Compare drive option \(turn + 1) with the last one, and say what changes for the panel."])
            steps.append(["id": "check-\(turn)", "sequence": turn + 1, "kind": "command", "status": "completed", "title": "Ran",
                          "command": "python compare_drives.py --option \(turn + 1)", "exitCode": 0, "durationMs": 4_000, "startedAt": at(base - 60)])
            let lead = turn == 11 ? "Final comparison: the second drive wins." : "Option \(turn + 1) against the last one."
            let bullets: [String] = (0..<(3 + turn % 4)).map { point in
                "- **Point \(point + 1):** the drive's rated current, its cooling and the cable run all change, so the breaker and the conduit fill need checking again before anything is ordered."
            }
            let text = "**\(lead)**\n" + bullets.joined(separator: "\n")
                + "\n\n1. Check the breaker.\n2. Check the conduit fill.\n\n```sh\npython compare_drives.py --option \(turn + 1) --report\n```"
            messages.append(["id": "reply-\(turn)", "role": "assistant", "createdAt": at(base - 120), "text": text])
        }
        steps.append(["id": "long-final", "sequence": 13, "kind": "command", "status": "completed", "title": "Ran",
                      "command": "python summarize_drives.py", "exitCode": 0, "durationMs": 2_000, "startedAt": at(30)])
        return (messages, steps)
    }
    /// The working thread's worktree record, as a host sends it: its own branch, uncommitted changes and a draft pull request.
    private static var fixtureWorktree: [String: Any] {
        let pullRequest: [String: Any] = ["number": 721, "title": "Let the window frost and put a terminal in the bottom third",
                                          "url": "https://github.com/millZach/Sotto/pull/721", "state": "open", "draft": true]
        let git: [String: Any] = ["branch": "feat/frosted-window-and-pane-terminal", "changedFiles": 7, "insertions": 212,
                                  "deletions": 48, "ahead": 4, "behind": 0, "dirty": true, "pullRequest": pullRequest]
        return ["mode": "independent", "branch": "feat/frosted-window-and-pane-terminal", "git": git]
    }
    /// A one-question request with three choices and room for the user's own words.
    private static var fixtureQuestion: [String: Any] {
        let choices: [[String: String]] = [
            ["id": "j", "label": "Ctrl+J", "description": "T3 Code’s own. Free on Windows; dictation doesn’t use it."],
            ["id": "tick", "label": "Ctrl+`", "description": "What the branch uses now. Clashes when dictation holds it."],
            ["id": "none", "label": "No shortcut", "description": "Open it from the Terminal button only."]
        ]
        let question: [String: Any] = ["id": "shortcut", "question": "Which shortcut should open the terminal drawer?",
                                       "options": choices, "multiSelect": false, "allowFreeText": true, "required": true]
        let none: [[String: String]] = []
        return ["id": "drawer-shortcut", "kind": "question", "text": "Which shortcut should open the terminal drawer?",
                "options": none, "questions": [question]]
    }
    /// A review reply as an agent wrote it, in Markdown: bold headings, a bulleted and a numbered list with bold lead-ins,
    /// key chords that end in a backtick, a fenced code block, a table narrow enough for a grid and one too wide for it.
    private static let fixtureReview = """
    **Not asked for**
    - **Remembered state:** open state and height are remembered per thread across restarts.
    - **The shortcut itself:** the spec named no key. The code comment calls Ctrl+` "T3's own", and the reviewer recalls T3 uses Mod+J (unverified). Ctrl+` is also blocked in the Tools and Terminal-mode terminals.
    - **Reduce transparency:** the frost follows the system's reduce-transparency setting.

    **Implemented but looks wrong**
    1. **Ctrl+` in Terminal mode:** the same off-screen drawer toggle as Standards #2.
    2. **Tooltips:** they always say "(Ctrl+`)", even when dictation owns that chord and the shortcut is off.

    The check I ran:

    ```sh
    npm test -- tests/unit/renderer/terminalDrawer.test.ts
    ```

    Where the time went:

    | Step | Before | After |
    |---|---:|---:|
    | Open the thread | 1.2 s | 0.3 s |
    | First reply | 2.4 s | 0.9 s |

    What is left:

    | Finding | Where | Fixed | What to do next |
    |---|---|:---:|---|
    | Drawer toggle | Terminal mode | No | Move the toggle on screen before the drawer opens |
    | Tooltips | Every pane | No | Name the chord only while the shortcut is on |
    """
    /// The fixture has no computer to carry an answer, so once the answer is checked its request leaves the thread, as
    /// it would when the computer confirmed it.
    private func settleFixtureAnswer(_ request: AgentRequest, in ref: ThreadRef) throws {
        guard var root = fixtureShells[ref.hostID], var host = root["host"] as? [String: Any],
              var rows = host["threads"] as? [[String: Any]],
              let index = rows.firstIndex(where: { ($0["id"] as? String) == ref.threadID }) else { return }
        let waiting = rows[index]["requests"] as? [[String: Any]] ?? []
        rows[index]["requests"] = waiting.filter { ($0["id"] as? String) != request.id }
        host["threads"] = rows
        root["host"] = host
        let next = try JSONDecoder().decode(Shell.self, from: JSONSerialization.data(withJSONObject: root))
        fixtureShells[ref.hostID] = root
        update(ref.hostID) { $0.shell = next }
        confirmedAnswers.insert(ref.hostID + "/" + ref.threadID + "/" + request.id)
        feedback = String(localized: "Answer sent.", comment: "Said once the computer confirms the user's answer to a request")
    }

    // MARK: Watcher in the simulator journeys

    /// Fix login test asks which account to use: one question with two choices and room for the user's own words.
    private static var fixtureLoginQuestion: [String: Any] {
        let choices: [[String: String]] = [["id": "fresh", "label": "A fresh account for each run"],
                                           ["id": "seeded", "label": "The seeded test user, one run at a time"]]
        let question: [String: Any] = ["id": "account", "question": "Which account should the login test sign in with?",
                                       "options": choices, "multiSelect": false, "allowFreeText": true, "required": true]
        let none: [[String: String]] = []
        return ["id": "login-account", "kind": "question", "text": "Which account should the login test sign in with?",
                "options": none, "questions": [question]]
    }
    /// Babysit #845 release notes asks to publish the notes: a permission, taller than Fix login test's question.
    private static var fixtureNotesPublish: [String: Any] {
        let choices: [[String: String]] = [["id": "notes-once", "label": "Allow once", "kind": "allow-once"],
                                           ["id": "notes-deny", "label": "Deny", "kind": "deny"]]
        return ["id": "notes-publish", "kind": "permission",
                "text": "Wants to publish the release notes for #845 to the draft release, replacing the notes already there.",
                "options": [[String: String]](), "permissionChoices": choices,
                "context": ["command": "gh release edit v0.84.5 --draft --notes-file docs/release/notes-845.md"]]
    }
    /// Babysit #845 release notes's permission as a card in Watcher's page.
    private static func fixtureNotesPermission(laptop: String, mayAnswer: Bool) -> [String: Any] {
        ["target": ["hostId": laptop, "threadId": "notes845"], "title": "Babysit #845 release notes", "provider": "codex",
         "request": fixtureNotesPublish, "connected": true, "mayAnswer": mayAnswer]
    }
    /// The laptop's Watcher page: a morning's exchange with what Watcher did for each reply, three threads watched until
    /// the user stops them, one it no longer watches, a reply in which Watcher changed two files itself, with its reason
    /// unless `reasoned` is false, and Fix login test's question waiting. Watcher asks before actions. With `asks`,
    /// Watcher itself waits for permission to run a command.
    private static func fixtureWatcherPage(laptop: String, studio: String, mayAnswer: Bool, asks: Bool, reasoned: Bool,
                                           at: @escaping (Double) -> String) -> [String: Any] {
        let watcher: [String: String] = ["hostId": laptop, "threadId": "watcher"]
        let login: [String: String] = ["hostId": laptop, "threadId": "login"]
        let notes: [String: String] = ["hostId": laptop, "threadId": "notes845"]
        let fixed = reasoned ? "I fixed “npm instal” in README.md and docs/guide.md myself: a one-word typo in two files is smaller than briefing a thread."
            : "The install line is fixed."
        let messages: [[String: Any]] = [
            ["id": "ask-login", "role": "user", "createdAt": at(40 * 60),
             "text": "The login test fails about one run in five. Start a thread to fix it on Claude Code, in a new worktree."],
            ["id": "started-login", "role": "assistant", "createdAt": at(39 * 60), "text": "Started it. I’ll tell you what it finds."],
            ["id": "ask-notes", "role": "user", "createdAt": at(14 * 60), "text": "How are the release notes for #845 doing?"],
            ["id": "noted", "role": "assistant", "createdAt": at(13 * 60),
             "text": "**Babysit #845 release notes** is waiting for the checks on #845. I asked it to tell me when they pass. " + fixed],
            ["id": "found", "role": "assistant", "createdAt": at(3 * 60),
             "text": "**Fix login test** found the cause: overlapping runs share one account. It’s asking you which account to use. Only you can answer it."]
        ]
        func receipt(_ id: String, _ target: [String: String], _ title: String, _ provider: String, _ action: String, _ minutes: Double) -> [String: Any] {
            ["operationId": id, "target": target, "title": title, "provider": provider, "action": action,
             "deliveryState": "accepted", "createdAt": at(minutes * 60), "updatedAt": at(minutes * 60)]
        }
        let groups: [[String: Any]] = [
            ["replyMessageId": "started-login", "requestId": "aaaaaaaa-0000-4000-8000-000000000001",
             "rows": [receipt("bbbbbbbb-0000-4000-8000-000000000001", login, "Fix login test", "claude", "start", 39)]],
            ["replyMessageId": "noted", "requestId": "aaaaaaaa-0000-4000-8000-000000000002",
             "rows": [receipt("bbbbbbbb-0000-4000-8000-000000000002", notes, "Babysit #845 release notes", "codex", "send", 13)]]
        ]
        func watched(_ target: [String: String], _ title: String, _ provider: String, _ status: String, _ watched: Bool) -> [String: Any] {
            ["target": target, "title": title, "provider": provider, "status": status, "connected": true, "watched": watched,
             "takenOver": false, "backgroundWorkCount": 0]
        }
        let android: [String: String] = ["hostId": studio, "threadId": "android"]
        let watches: [[String: Any]] = [(login, 39.0, 1), (notes, 30.0, 2), (android, 25.0, 3)].map { target, minutes, index -> [String: Any] in
            ["id": "dddddddd-0000-4000-8000-00000000000\(index)", "target": target, "createdAt": at(minutes * 60), "generation": 1]
        }
        // Sotto's own count of what Watcher changed in its reply, and its reason in its own words.
        let reason: Any = reasoned ? "A one-word typo in two files is smaller than briefing a thread." as Any : NSNull() as Any
        let change: [String: Any] = ["replyMessageId": "noted", "turnId": "turn-noted", "files": ["README.md", "docs/guide.md"], "fileCount": 2,
                                     "reason": reason, "source": "provider-file-change"]
        let threads: [[String: Any]] = [
            watched(login, "Fix login test", "claude", "running", true),
            watched(notes, "Babysit #845 release notes", "codex", "running", true),
            watched(android, "Add Android share sheet", "claude", "running", true),
            watched(["hostId": studio, "threadId": "webhook"], "Payment webhook retries", "codex", "idle", false)
        ]
        var cards: [[String: Any]] = [["target": login, "title": "Fix login test", "provider": "claude", "request": fixtureLoginQuestion,
                                       "connected": true, "mayAnswer": mayAnswer]]
        if asks {
            let choices: [[String: String]] = [["id": "watcher-once", "label": "Allow once", "kind": "allow-once"],
                                               ["id": "watcher-deny", "label": "Deny", "kind": "deny"]]
            let request: [String: Any] = ["id": "watcher-checks", "kind": "permission", "text": "Wants to run gh pr checks 845.",
                                          "options": [[String: String]](), "permissionChoices": choices, "context": ["command": "gh pr checks 845"]]
            cards.append(["target": watcher, "title": "Watcher", "provider": "codex", "request": request, "connected": true, "mayAnswer": mayAnswer])
        }
        // Watcher waits between turns while its workers run, so its permissions can change unless its own request waits.
        let current: [String: Any] = ["target": watcher, "provider": "codex", "modelId": "fixture-model", "reasoningEffort": "high",
                                      "status": "idle", "connected": true, "runtimeMode": WatcherPermissions.first]
        return ["hostId": laptop, "current": current,
                "conversation": ["messages": messages, "earlierAvailable": false, "revision": 5],
                "receiptGroups": groups, "watchedThreads": threads, "needsYou": cards,
                "inFlight": 3, "inFlightLimit": 4, "working": !asks, "observedAt": at(0),
                "runtimeMode": WatcherPermissions.first, "standingWatches": watches, "ownChanges": [change]]
    }
    /// Changes the fixture's Watcher page as the laptop would, and shows it.
    private func changeFixtureWatcher(on hostID: String, _ change: (inout [String: Any]) -> Void) {
        guard var page = fixtureWatcher else { return }
        change(&page)
        page["observedAt"] = ISO8601DateFormatter().string(from: Date())
        fixtureWatcher = page
        if let decoded = try? JSONDecoder().decode(WatcherPage.self, from: JSONSerialization.data(withJSONObject: page)) {
            showWatcher(decoded, on: hostID)
        }
    }
    /// The laptop keeps the mode for Watcher a moment after it is chosen, and Watcher's provider confirms it a while later,
    /// so the chip says what is still in force between the two. The while is long enough for CI's SE, where one look at
    /// Watcher's page can take eight seconds, to find the caption before it goes.
    private func setFixtureWatcherPermission(_ mode: String, on hostID: String) async {
        try? await Task.sleep(nanoseconds: 300_000_000)
        changeFixtureWatcher(on: hostID) { $0["runtimeMode"] = mode }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self?.changeFixtureWatcher(on: hostID) { page in
                guard var current = page["current"] as? [String: Any] else { return }
                current["runtimeMode"] = page["runtimeMode"]
                page["current"] = current
            }
        }
    }
    /// The laptop watches the thread until the user stops it, or stops watching it, as it would: a watched row with its
    /// standing watch, or the row no longer watched and its watch gone.
    private func watchFixtureThread(_ ref: ThreadRef, _ watched: Bool, title: String, on hostID: String) async {
        try? await Task.sleep(nanoseconds: 300_000_000)
        let target: [String: String] = ["hostId": ref.hostID, "threadId": ref.threadID]
        let listed = thread(ref)
        changeFixtureWatcher(on: hostID) { page in
            var rows = page["watchedThreads"] as? [[String: Any]] ?? []
            var watches = page["standingWatches"] as? [[String: Any]] ?? []
            let same: ([String: Any]) -> Bool = { ($0["target"] as? [String: String]) == target }
            watches.removeAll(where: same)
            if let index = rows.firstIndex(where: same) {
                rows[index]["watched"] = watched
                rows[index]["takenOver"] = false
            } else if watched {
                var row: [String: Any] = ["target": target, "title": title, "status": listed?.status ?? "idle", "connected": true,
                                          "watched": true, "takenOver": false, "backgroundWorkCount": 0]
                if let provider = listed?.providerId { row["provider"] = provider }
                rows.append(row)
            }
            if watched {
                watches.append(["id": UUID().uuidString.lowercased(), "target": target, "generation": 1,
                                "createdAt": ISO8601DateFormatter().string(from: Date())])
            }
            page["watchedThreads"] = rows
            page["standingWatches"] = watches
        }
    }
    /// A pull to refresh reads nothing new from the fixture's computer, except in the journey that checks a reader of
    /// earlier messages keeps their place: there Watcher says something new each time.
    private func refreshFixtureWatcher(on hostID: String) {
        guard ProcessInfo.processInfo.arguments.contains("--ui-watcher-refresh-news") else { return }
        appendFixtureWatcherMessage(["id": "refresh-" + UUID().uuidString, "role": "assistant",
                                     "createdAt": ISO8601DateFormatter().string(from: Date()),
                                     "text": "Nothing new needs you. Babysit #845 release notes is still waiting for its checks."], on: hostID)
    }
    /// Watcher writes one long reply a few words at a time, twice a second for two minutes, and `cards` arrive under it a
    /// moment after it starts, as a worker's question reaches Watcher's page while Watcher writes.
    private func keepFixtureWatcherWriting(on hostID: String, then cards: Any?) {
        let id = "writing-" + UUID().uuidString
        appendFixtureWatcherMessage(["id": id, "role": "assistant", "createdAt": ISO8601DateFormatter().string(from: Date()),
                                     "text": "Checking the threads I watch."], on: hostID)
        Task { [weak self] in
            for tick in 1...240 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self else { return }
                changeFixtureWatcher(on: hostID) { page in
                    if tick == 3, let cards { page["needsYou"] = cards }
                    guard var conversation = page["conversation"] as? [String: Any],
                          var messages = conversation["messages"] as? [[String: Any]],
                          let index = messages.firstIndex(where: { $0["id"] as? String == id }) else { return }
                    messages[index]["text"] = (messages[index]["text"] as? String ?? "") + " Still waiting on #845’s checks."
                    conversation["messages"] = messages
                    conversation["revision"] = (conversation["revision"] as? Int ?? 0) + 1
                    page["conversation"] = conversation
                }
            }
        }
    }
    /// The Darwin notification the two-card journey posts when the laptop should answer Babysit #845 release notes's
    /// permission. The journey decides when, so the card leaves only once the reader is held on the question above it.
    private static let fixtureNotesAnsweredSignal = "app.sotto.ui.watcher-notes-answered"
    /// What the signal does, as a C callback can't hold the model.
    private static var fixtureNotesAnswered: (() -> Void)?
    /// The laptop answers Babysit #845 release notes's permission when the journey signals it: the card leaves Watcher's
    /// page on its own, as a card answered elsewhere does, and Watcher's conversation and its revision stay as they are.
    private func answerFixtureNotesWhenAsked(on hostID: String) {
        Self.fixtureNotesAnswered = { [weak self] in
            self?.changeFixtureWatcher(on: hostID) { page in
                let cards = page["needsYou"] as? [[String: Any]] ?? []
                page["needsYou"] = cards.filter { (($0["request"] as? [String: Any])?["id"] as? String) != "notes-publish" }
            }
        }
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            Task { @MainActor in AppModel.fixtureNotesAnswered?() }
        }, Self.fixtureNotesAnsweredSignal as CFString, nil, .deliverImmediately)
    }
    private func appendFixtureWatcherMessage(_ message: [String: Any], on hostID: String, receipts: [String: Any]? = nil) {
        changeFixtureWatcher(on: hostID) { page in
            guard var conversation = page["conversation"] as? [String: Any] else { return }
            conversation["messages"] = (conversation["messages"] as? [[String: Any]] ?? []) + [message]
            conversation["revision"] = (conversation["revision"] as? Int ?? 0) + 1
            page["conversation"] = conversation
            if let receipts { page["receiptGroups"] = (page["receiptGroups"] as? [[String: Any]] ?? []) + [receipts] }
        }
    }
    /// Watcher takes the words, then a moment later answers and sends Babysit #845 release notes a note.
    private func sendToFixtureWatcher(_ text: String, on hostID: String) async {
        let stamp = ISO8601DateFormatter()
        appendFixtureWatcherMessage(["id": "phone-" + UUID().uuidString, "role": "user", "text": text, "createdAt": stamp.string(from: Date())], on: hostID)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            self?.answerFixtureWatcher(on: hostID)
        }
    }
    private func answerFixtureWatcher(on hostID: String) {
        let stamp = ISO8601DateFormatter()
        let reply = "phone-reply-" + UUID().uuidString
        let notes: [String: String] = ["hostId": hostID, "threadId": "notes845"]
        let row: [String: Any] = ["operationId": UUID().uuidString.lowercased(), "target": notes, "title": "Babysit #845 release notes",
                                  "provider": "codex", "action": "send", "delivery": "queue", "deliveryState": "accepted",
                                  "createdAt": stamp.string(from: Date()), "updatedAt": stamp.string(from: Date())]
        appendFixtureWatcherMessage(["id": reply, "role": "assistant", "createdAt": stamp.string(from: Date()),
                                     "text": "On it. I asked **Babysit #845 release notes** to tell me when the checks pass."],
                                    on: hostID, receipts: ["replyMessageId": reply, "requestId": UUID().uuidString.lowercased(), "rows": [row]])
    }
    /// The fixture has no computer to carry the answer: once it is checked, the card leaves Watcher's page and its
    /// thread, as it would when the computer confirmed it.
    private func settleFixtureWatcherCard(_ card: WatcherPage.RequestCard, on hostID: String) {
        changeFixtureWatcher(on: hostID) { page in
            let cards = page["needsYou"] as? [[String: Any]] ?? []
            page["needsYou"] = cards.filter { (($0["request"] as? [String: Any])?["id"] as? String) != card.request.id }
        }
        if card.target.hostId == hostID, thread(card.target.ref) != nil { try? settleFixtureAnswer(card.request, in: card.target.ref) }
        confirmedAnswers.insert(hostID + "/" + card.target.threadId + "/" + card.request.id)
        feedback = String(localized: "Answer sent.", comment: "Said once the computer confirms the user's answer to a request")
    }
    private func fixtureWatcherStopPreview(_ hostID: String) -> WatcherStopPreview? {
        guard let page = watcherPage(hostID) else { return nil }
        let targets: [[String: Any]] = page.watched.filter { !$0.takenOver }.map { thread -> [String: Any] in
            var target: [String: Any] = ["hostId": thread.target.hostId, "threadId": thread.target.threadId, "title": thread.title]
            if let provider = thread.provider { target["provider"] = provider }
            return target
        }
        let preview: [String: Any] = ["status": "ok", "confirmationId": "cccccccc-0000-4000-8000-000000000001", "targets": targets,
                                      "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))]
        return try? JSONDecoder().decode(WatcherStopPreview.self, from: JSONSerialization.data(withJSONObject: preview))
    }
    private func stopFixtureWatcher(_ preview: WatcherStopPreview, on hostID: String, titles: [String: String]) {
        let stopping = Set(preview.targets.map { $0.hostId + "/" + $0.threadId })
        changeFixtureWatcher(on: hostID) { page in
            let threads = page["watchedThreads"] as? [[String: Any]] ?? []
            page["watchedThreads"] = threads.map { thread -> [String: Any] in
                guard let target = thread["target"] as? [String: String], let host = target["hostId"], let id = target["threadId"],
                      stopping.contains(host + "/" + id) else { return thread }
                var stopped = thread; stopped["watched"] = false; stopped["status"] = "idle"
                return stopped
            }
            page["inFlight"] = 0
            page["working"] = false
        }
        let outcomes: [[String: Any]] = preview.targets.map { target in
            ["target": ["hostId": target.hostId, "threadId": target.threadId], "status": "stopped", "message": "Stopped."]
        }
        let results = (try? JSONDecoder().decode([WatcherStopResult.StoppedTarget].self,
                                                 from: JSONSerialization.data(withJSONObject: outcomes))) ?? []
        feedback = WatcherWords.stopped(results, titles: titles)
    }
    #endif

    // MARK: Reading

    func computer(_ hostID: String) -> SavedComputer? { computers.first { $0.hostID == hostID } }
    /// Where a computer's question pages open (ADR-0085): the address its connection reached, which can be phone access's
    /// other port, else the one it was saved with.
    func pageEndpoint(_ hostID: String) -> HostEndpoint? { connections[hostID]?.reached ?? computer(hostID)?.endpoint }
    func name(_ hostID: String) -> String {
        computer(hostID)?.name ?? String(localized: "the computer", comment: "Stands in for a computer's name in a sentence when the name isn't known")
    }
    func status(_ hostID: String) -> ComputerStatus { live[hostID]?.status ?? .connecting }
    func online(_ hostID: String) -> Bool { status(hostID) == .online }
    func mayAnswer(_ hostID: String) -> Bool { live[hostID]?.mayAnswer ?? false }
    /// The thread the user is reading now: the open thread while the app is on screen, or Watcher's own while its tab is.
    var threadOnScreen: ThreadRef? {
        guard foreground else { return nil }
        if watcherOnScreen, let hostID = watcherHostID, let ref = watcherPage(hostID)?.ownRef { return ref }
        return selected
    }
    func problem(_ hostID: String) -> String? { live[hostID]?.problem }
    var anyConnecting: Bool { computers.contains { status($0.hostID) == .connecting } }
    /// Every computer as the lists read it, in the order they were added.
    var lists: [ComputerThreads] {
        computers.map { computer in
            let state = live[computer.hostID]
            return ComputerThreads(hostID: computer.hostID, name: computer.name, status: state?.status ?? .connecting,
                                   threads: state?.shell?.host.threads ?? [], projects: state?.shell?.host.projects ?? [])
        }
    }
    func thread(_ ref: ThreadRef) -> ThreadSummary? { live[ref.hostID]?.shell?.host.threads.first { $0.id == ref.threadID } }
    func detail(for ref: ThreadRef) -> ThreadDetail? { selected == ref && openDetail?.threadId == ref.threadID ? openDetail : nil }
    /// The open thread as its page shows it: the latest copy, or while that is being read again, the copy read before,
    /// so a reconnect or a return to the thread never empties the page.
    func shown(for ref: ThreadRef) -> ThreadDetail? {
        if let detail = detail(for: ref) { return detail }
        guard selected == ref, let held = detailStore.held, held.ref == ref else { return nil }
        return held.detail
    }
    /// Lets go of the open thread's copy, holding it on screen until a fresh one is read.
    private func holdDetail() {
        if let selected, let openDetail, openDetail.threadId == selected.threadID {
            detailStore.held = HeldDetail(ref: selected, detail: openDetail)
        }
        openDetail = nil
    }
    private func scoped(_ hostID: String) -> [PendingOperation] {
        guard let computer = self.computer(hostID) else { return [] }
        return pending.filter { $0.matches(hostID: hostID, clientID: computer.pairing.clientId) }
    }
    func pending(for ref: ThreadRef) -> [PendingOperation] { scoped(ref.hostID).filter { $0.threadID == ref.threadID } }
    func provider(for ref: ThreadRef) -> Provider? {
        let providerID = thread(ref)?.providerId
        return live[ref.hostID]?.shell?.host.providers?.first { $0.id == providerID }
    }
    private func capabilities(for ref: ThreadRef) -> ProviderCapabilities? { provider(for: ref)?.capabilities ?? live[ref.hostID]?.shell?.host.capabilities }
    /// An answer this iPhone sent to that computer that it hasn't confirmed. Cards wait for it, so a card that
    /// moves under a finger after the first answer can't take a second tap meant for the first.
    func answering(_ hostID: String) -> Bool { scoped(hostID).contains { ["answer", "watcher-answer"].contains($0.kind) } }
    private func canAct(on ref: ThreadRef) -> Bool { online(ref.hostID) && thread(ref) != nil && pending(for: ref).isEmpty }
    /// Whether the reply box can send now. While the thread works, what it sends waits in the thread's queue.
    func canSend(_ ref: ThreadRef) -> Bool {
        guard canAct(on: ref), let thread = self.thread(ref), thread.requests.isEmpty else { return false }
        let source = provider(for: ref)
        return (capabilities(for: ref)?.submit ?? false) && (source == nil || source?.connection == "connected")
    }
    /// Whether a reply sent now is queued for after the running turn, rather than sent at once.
    func queuesReply(_ ref: ThreadRef) -> Bool { thread(ref)?.status == "running" }
    /// Whether the reply box holds something to send and nothing still being made ready: words or photos,
    /// every photo prepared, and none of them on a thread whose model can't take them.
    func canSendReply(_ ref: ThreadRef) -> Bool {
        let photos = self.photos(ref), files = self.files(ref)
        let written = !(drafts[ref.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return canSend(ref) && !preparingSends.contains(ref.id) && (written || !photos.isEmpty || !files.isEmpty)
            && !photos.contains(where: \.preparing) && (photos.isEmpty || photoSupport(ref) == .available)
            && !files.contains(where: \.reading) && (files.isEmpty || fileSupport(ref) == .available)
    }
    func photos(_ ref: ThreadRef) -> [DraftPhoto] { photos(.thread(ref)) }
    func photos(_ box: PhotoBox) -> [DraftPhoto] { draftPhotos[box.id] ?? [] }
    /// A thread's reply box's files. Watcher's box takes none yet (ADR-0131, October 25 amendment).
    func files(_ ref: ThreadRef) -> [DraftFile] { draftFiles[ref.id] ?? [] }
    func files(_ box: PhotoBox) -> [DraftFile] { if case .thread(let ref) = box { return files(ref) }; return [] }
    /// Whether a thread's reply box can take files: its computer keeps them only where its own `attach-any-file` answer is on.
    func fileSupport(_ ref: ThreadRef) -> FileSupport {
        FileSupport(online: online(ref.hostID), features: live[ref.hostID]?.features ?? [])
    }
    /// Whether a thread's computer hands its sent files back to open here (`attachment-files`).
    func opensSentFiles(_ hostID: String) -> Bool { live[hostID]?.features.contains(FileLimits.openingFeature) == true }
    func photoSupport(_ ref: ThreadRef) -> PhotoSupport { photoSupport(.thread(ref)) }
    func photoSupport(_ box: PhotoBox) -> PhotoSupport {
        let hostID = box.hostID, host = live[hostID]?.shell?.host, features = live[hostID]?.features ?? []
        switch box {
        case .thread(let ref): return PhotoSupport(online: online(hostID), thread: thread(ref), host: host, features: features)
        case .watcher: return PhotoSupport(online: online(hostID), watcher: watcherPage(hostID)?.current, host: host, features: features)
        }
    }
    /// A reply, answer or stop still on its way, as opposed to one its computer couldn't confirm.
    func isSending(_ item: PendingOperation) -> Bool { dispatchingOperations.keys.contains(item.id) || receiptFollowers[item.id] != nil }
    /// Stop waits only for another stop or an answer on its way; a reply, a queued reply, a steer or a removal never holds it.
    func canInterrupt(_ ref: ThreadRef) -> Bool {
        online(ref.hostID) && pending(for: ref).allSatisfy { ["reply", "queue", "steer", "remove"].contains($0.kind) }
            && thread(ref)?.status == "running" && (capabilities(for: ref)?.interrupt ?? false)
    }
    /// The thread's follow-up queue, in order, as the reply box shows it.
    func followups(_ ref: ThreadRef) -> [Followup] {
        FollowupQueue.items(live[ref.hostID]?.shell, threadID: ref.threadID, messages: shown(for: ref)?.messages)
    }
    /// Whether a queued message's card offers Steer now.
    func steerOffered(_ item: Followup, in ref: ThreadRef) -> Bool {
        guard let thread = self.thread(ref) else { return false }
        return FollowupQueue.steerOffered(item, thread: thread, capabilities: capabilities(for: ref))
    }
    /// Whether a press of Steer now would go now.
    func canSteer(_ item: Followup, in ref: ThreadRef) -> Bool {
        guard canAct(on: ref), steerOffered(item, in: ref), let thread = self.thread(ref), let shell = live[ref.hostID]?.shell else { return false }
        return FollowupQueue.steerClear(shell, thread: thread)
    }
    func canRemove(_ item: Followup, in ref: ThreadRef) -> Bool { canAct(on: ref) && FollowupQueue.removable(item) }
    /// Whether the thread offers Compact context at all.
    func compactionOffered(_ ref: ThreadRef) -> Bool {
        guard let thread = self.thread(ref) else { return false }
        return ContextCompaction.offered(capabilities(for: ref), thread: thread)
    }
    /// Why Compact context can't go now, in a few words, or nil when it can.
    func compactionHeld(_ ref: ThreadRef) -> String? {
        guard let thread = self.thread(ref) else { return String(localized: "This thread is no longer open", comment: "Why Compact context can't be pressed now") }
        if !online(ref.hostID) {
            return String(localized: "Available when \(name(ref.hostID)) is connected", comment: "Why Compact context can't be pressed now. %@ is the computer's name")
        }
        if !pending(for: ref).isEmpty || live[ref.hostID]?.shell?.busyThreadIds?.contains(ref.threadID) == true {
            return String(localized: "Available once \(name(ref.hostID)) confirms your last action", comment: "Why Compact context can't be pressed now. %@ is the computer's name")
        }
        let detail = shown(for: ref)
        return ContextCompaction.held(thread, messages: detail?.messages,
                                      earlierAvailable: detail?.earlierAvailable == true || thread.earlierAvailable == true)
    }
    func canAnswer(_ request: AgentRequest, in ref: ThreadRef) -> Bool {
        guard canAct(on: ref), mayAnswer(ref.hostID), request.supported else { return false }
        let allowed = capabilities(for: ref)
        return request.kind == "permission" ? (allowed?.permissions ?? false) : (allowed?.questions ?? false)
    }

    // MARK: Starting and stopping

    init(keychain: KeychainStore = KeychainStore(),
         retryJitter: @escaping @Sendable () -> Double = { Double.random(in: 0.8...1.2) },
         retrySleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
         preparePhoto: @escaping @Sendable (Data, String) async throws -> PreparedPhoto = { try await PhotoPipeline.prepare($0, name: $1) },
         receiptSleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
         photoLoadLimit: @escaping @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 120_000_000_000) }) {
        self.keychain = keychain
        self.retrySleep = retrySleep
        self.retryJitter = retryJitter
        self.preparePhoto = preparePhoto
        self.receiptSleep = receiptSleep
        self.photoLoadLimit = photoLoadLimit
        #if DEBUG && os(iOS)
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") {
            loadUIFixture()
            return
        }
        #endif
        loadComputers()
    }
    /// Secure storage may be locked during a prewarmed launch. Publish nothing until all reads succeed.
    private func loadComputers() {
        guard !storageReady else { return }
        let storageProblem = String(localized: "Secure connection details could not be read. Unlock this iPhone and return to Sotto.")
        do {
            var warnings: [String] = []
            let noticesAccount = "recovery-notices"
            let previousNotices: [String]
            var resetNotices = false
            do { previousNotices = try keychain.read([String].self, account: noticesAccount) ?? [] }
            catch is KeychainStore.UndecodableItem {
                // This is only notice bookkeeping. Healthy pairings must still load; actual
                // Keychain access failures keep refusing the load through the outer catch.
                previousNotices = []; resetNotices = true
            }
            var notices = Set(previousNotices)
            var unreadableComputers = 0
            func unreadableComputer(_ account: String) {
                if notices.insert(account).inserted { unreadableComputers += 1 }
            }
            var announceRecovery = false
            var index: [String]?
            var indexAccount: String? = ComputerStore.indexAccount
            var recoveredIndex = false
            do { index = try keychain.read([String].self, account: ComputerStore.indexAccount) }
            catch is KeychainStore.UndecodableItem {
                // Preserve the original bytes. A separate index keeps the recovered order on later
                // launches and is the one pairing and removal may update from now on.
                recoveredIndex = true; indexAccount = ComputerStore.recoveredIndexAccount
                announceRecovery = !(try keychain.accounts()).contains(ComputerStore.recoveredIndexAccount)
                do { index = try keychain.read([String].self, account: ComputerStore.recoveredIndexAccount) }
                catch is KeychainStore.UndecodableItem { index = nil; indexAccount = nil }
                let accounts = try keychain.accounts()
                let discovered = accounts.filter { $0.hasPrefix("computer.") }.map { String($0.dropFirst("computer.".count)) }.sorted()
                index = (index ?? []) + discovered
            }
            var legacy: SavedComputer?
            do { legacy = try readComputer(ComputerStore.legacyAccount) }
            catch is KeychainStore.UndecodableItem { unreadableComputer(ComputerStore.legacyAccount) }
            let plan = ComputerStore.plan(index: index, legacy: legacy)
            var kept: [SavedComputer] = []
            for hostID in plan.index {
                do {
                    let computer = try plan.adopt.flatMap { $0.hostID == hostID ? $0 : nil }
                        ?? readComputer(ComputerStore.account(hostID))
                    if let computer, computer.hostID == hostID { kept.append(computer) }
                    else { unreadableComputer(ComputerStore.account(hostID)) }
                } catch is KeychainStore.UndecodableItem {
                    unreadableComputer(ComputerStore.account(hostID))
                }
            }
            var markers: [PendingOperation] = []
            do { markers = try keychain.read([PendingOperation].self, account: ComputerStore.pendingAccount) ?? [] }
            catch is KeychainStore.UndecodableItem {
                if notices.insert(ComputerStore.pendingAccount).inserted { warnings.append(Self.markersUnreadable) }
            }
            // All reads must succeed before migration writes: a locked item never looks missing.
            if let adopt = plan.adopt { try keychain.write(adopt, account: ComputerStore.account(adopt.hostID)) }
            if let indexAccount, recoveredIndex || plan.index != index { try keychain.write(plan.index, account: indexAccount) }
            if plan.removeLegacy { try keychain.remove(account: ComputerStore.legacyAccount) }
            if resetNotices || notices != Set(previousNotices) { try keychain.write(notices.sorted(), account: noticesAccount) }
            // A terminal answer saved by a build that still had Terminal mode has nothing left to settle it.
            pending = markers.filter { marker in
                marker.kind != "terminal-answer" && kept.contains { marker.matches(hostID: $0.hostID, clientID: $0.pairing.clientId) }
            }
            computers = kept; computerIndexAccount = indexAccount
            for computer in kept { live[computer.hostID] = Live() }
            storageReady = true
            if unreadableComputers > 0 { warnings.append(Self.pairingWarning(unreadableComputers)) }
            if announceRecovery {
                warnings.insert(kept.isEmpty ? String(localized: "The saved computer list could not be recovered.")
                                    : String(localized: "Recovered the saved computer list."), at: 0)
            }
            if !warnings.isEmpty { feedback = warnings.joined(separator: " "); pairFeedback = feedback }
            else {
                if feedback == storageProblem { feedback = nil }
                if pairFeedback == storageProblem { pairFeedback = nil }
            }
        } catch {
            feedback = storageProblem
            pairFeedback = feedback
        }
    }
    /// Invalid records need pairing again. A Keychain access failure still refuses the entire load.
    private func readComputer(_ account: String) throws -> SavedComputer? {
        guard let computer = try keychain.read(SavedComputer.self, account: account) else { return nil }
        do { try computer.validate(); return computer }
        catch { throw KeychainStore.UndecodableItem(account: account) }
    }
    func phase(_ phase: ScenePhase) {
        foreground = phase == .active
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        if phase == .active {
            let wasStorageReady = storageReady
            loadComputers()
            guard !active || (!wasStorageReady && storageReady) else { return }; active = true
            guard storageReady else { return }
            activationConnection = Task { await reconnectAll() }
        } else if phase == .background {
            cancelDetailReload()
            retries.values.forEach { $0.cancel() }; retries.removeAll(); retryAttempts.removeAll(); retryingSince.removeAll()
            active = false; pairGeneration = UUID(); working = false; holdDetail()
            for (hostID, connection) in connections { generations[hostID] = UUID(); connection.disconnect() }
            connecting.removeAll(); watches.removeAll(); watcherWatches.removeAll()
            // A computer that gave up stays given up: coming back connects only the others.
            live = live.mapValues { (state: Live) -> Live in
                var next = state; next.mayAnswer = false
                if next.status != .unreachable { next.status = .connecting }
                return next
            }
        }
    }
    /// Wait for the connection work scheduled by activation, including delivery checks.
    func waitForActivation() async { await activationConnection?.value }
    /// Wait until every photo chosen so far has been prepared and staged, or has left its reply box.
    func waitForPhotos() async {
        await photoWork?.value
        for task in Array(stagingTasks.values) { _ = await task.value }
        await fileWork?.value
        for task in Array(fileStagingTasks.values) { _ = await task.value }
    }
    /// Connects every computer that hasn't given up. One that gave up waits for its Try again or Reconnect.
    func reconnectAll() async {
        let ids = computers.map(\.hostID).filter { status($0) != .unreachable }
        await withTaskGroup(of: Void.self) { group in
            for hostID in ids { group.addTask { await self.connect(hostID) } }
        }
    }
    /// Pull to refresh: reconnects every computer that hasn't given up, but returns once the ones that were
    /// reachable are back, rather than waiting out one still connecting. With none reachable, it waits for all.
    func refresh() async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        let started = computers.filter { status($0.hostID) != .unreachable }.map { computer in
            (reachable: online(computer.hostID), task: Task { await connect(computer.hostID) })
        }
        let awaited = started.contains { $0.reachable } ? started.filter { $0.reachable } : started
        for item in awaited { await item.task.value }
    }
    /// A fresh session, shell and open-thread detail from one computer. Only that computer's state changes.
    /// While the computer is already connecting, this waits for that attempt, delivery check included,
    /// rather than starting another, so a refresh or reconnect never returns before the computer is ready.
    func connect(_ hostID: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard storageReady, active, let saved = computer(hostID) else { return }
        if connecting.contains(hostID) {
            await withCheckedContinuation { connectWaiters[hostID, default: []].append($0) }
            return
        }
        retries.removeValue(forKey: hostID)?.cancel()
        let current = UUID(); generations[hostID] = current; connecting.insert(hostID)
        shellSequences[hostID] = 0; watches[hostID] = nil; watcherWatches[hostID] = nil
        defer { if generations[hostID] == current { connecting.remove(hostID) } }
        update(hostID) { $0.status = .connecting; $0.mayAnswer = false; $0.problem = nil }
        if selected?.hostID == hostID { cancelDetailReload(); holdDetail(); detailProblem = nil }
        var helloCarriedWatcher = false
        // Hello's page is made after every send over an earlier connection ended: it says where their drafts stand.
        let proof = watcherDrafts[hostID]?.endedSends ?? [:]
        do {
            guard let endpoint = saved.endpoint else { throw ClientError.invalidHost }
            let greeting = try await connection(hostID).connect(endpoint: endpoint, pairing: saved.pairing)
            guard generations[hostID] == current else { return }
            try applyShell(greeting.value.shell, from: hostID, sequence: greeting.sequence, reconcileAnswers: false)
            update(hostID) {
                $0.status = .online
                // An older host can push a newer shell before hello finishes, without this field.
                if $0.shell?.clientCapabilities == nil { $0.mayAnswer = greeting.value.capabilities.mayAnswer }
                $0.features = greeting.value.features ?? []
            }
            // Hello's shell was read before its features said whether this computer runs Watcher.
            if let page = greeting.value.shell.watcher { applyWatcher(page, from: hostID, proof: proof); helloCarriedWatcher = true }
            wasOnline.insert(hostID)
            if let selected, selected.hostID == hostID, thread(selected) == nil { self.selected = nil }
        } catch {
            guard generations[hostID] == current else { return }
            connections[hostID]?.disconnect()
            var retrying = true
            if let error = error as? ClientError {
                switch error {
                case .invalidIdentity, .invalidProtocol, .invalidHost, .rejected: retrying = false
                default: break
                }
            }
            connectionEnded(hostID, problem: problemWords(error, hostID: hostID), retrying: retrying)
            return
        }
        retries.removeValue(forKey: hostID)?.cancel()
        // A refused or slow thread read does not mean the computer's connection was lost.
        do { try await observeAndRead(hostID) }
        catch { if generations[hostID] == current { detailProblem = String(localized: "This thread could not be loaded. Nothing was lost. Try again.") } }
        if generations[hostID] == current, !helloCarriedWatcher { await readWatcher(hostID) }
        await checkDelivery(hostID)
        // A Stop all whose outcome is still unknown is read once this attempt is over: a computer still carrying it out
        // can keep its receipt pending for minutes, and connecting must not wait on that.
        if generations[hostID] == current, watcherStops[hostID] != nil {
            Task { [weak self] in await self?.recoverWatcherStop(hostID) }
        }
    }
    /// A connection that failed or was lost. A computer that has been online is tried again quietly, reading
    /// Connecting, until its quiet retries run out; any other gives up: it reads Can't reach it, with the problem on its
    /// own page, and nothing connects it until the user presses Try again or Reconnect.
    private func connectionEnded(_ hostID: String, problem: String, retrying: Bool) {
        let since = retryingSince[hostID] ?? Date()
        if retrying, active, wasOnline.contains(hostID), (retryAttempts[hostID] ?? 0) < Self.quietRetries,
           Date().timeIntervalSince(since) < Self.quietRetryWindow {
            retryingSince[hostID] = since
            update(hostID) { $0.status = .connecting; $0.mayAnswer = false; $0.problem = problem }
            scheduleRetry(hostID)
            return
        }
        retries.removeValue(forKey: hostID)?.cancel(); retryAttempts[hostID] = nil; retryingSince[hostID] = nil; wasOnline.remove(hostID)
        update(hostID) { $0.status = .unreachable; $0.mayAnswer = false; $0.problem = problem }
    }
    /// Why a connection failed, naming the computer as this iPhone does. A computer that didn't answer reads the same
    /// on either of phone access's ports.
    private func problemWords(_ error: Error, hostID: String) -> String {
        if error is URLError { return ClientError.hostUnreachable(name(hostID)).localizedDescription }
        if let error = error as? ClientError, case .hostUnreachable = error { return ClientError.hostUnreachable(name(hostID)).localizedDescription }
        return error.localizedDescription
    }
    private func scheduleRetry(_ hostID: String) {
        guard active, computer(hostID) != nil, retries[hostID] == nil else { return }
        let attempt = retryAttempts[hostID] ?? 0
        retryAttempts[hostID] = attempt + 1
        let delay = UInt64(min(30, Double(1 << min(attempt, 5)) * retryJitter()) * 1_000_000_000)
        let sleep = retrySleep
        retries[hostID] = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            guard !Task.isCancelled, let self, self.active, self.computer(hostID) != nil else { return }
            self.retries[hostID] = nil
            await self.connect(hostID)
        }
    }
    /// An attempt ends when its computer leaves `connecting`: it finished, or a disconnect, removal or
    /// the app going to the background ended it early.
    private func releaseConnectWaiters() {
        for hostID in Array(connectWaiters.keys) where !connecting.contains(hostID) {
            connectWaiters.removeValue(forKey: hostID)?.forEach { $0.resume() }
        }
    }
    private func connection(_ hostID: String) -> HostConnection {
        if let existing = connections[hostID] { return existing }
        let made = HostConnection()
        made.onLiveness = { [weak self] in self?.retryAttempts[hostID] = nil; self?.retryingSince[hostID] = nil }
        made.onPush = { [weak self] frame, sequence in self?.push(frame, from: hostID, sequence: sequence) }
        made.onDisconnect = { [weak self] in
            guard let self else { return }
            generations[hostID] = UUID(); connecting.remove(hostID); watches[hostID] = nil; watcherWatches[hostID] = nil
            if selected?.hostID == hostID { cancelDetailReload() }
            connectionEnded(hostID, problem: ClientError.disconnected.localizedDescription, retrying: true)
        }
        connections[hostID] = made
        return made
    }
    private func update(_ hostID: String, _ change: (inout Live) -> Void) {
        guard computer(hostID) != nil else { return }
        let before = live[hostID]
        var state = before ?? Live(); change(&state)
        // Setting `live` publishes on the whole model, so a state that changed nothing is left as it was.
        if state == before && !Self.publishesEverything { return }
        live[hostID] = state
    }

    // MARK: Adding a computer

    func startAdding() { found = nil; pairFeedback = nil; adding = true }
    /// The sheet closed. A code already spent still finishes pairing; anything else is dropped.
    func closeAdding() { adding = false; pairGeneration = UUID(); working = false; found = nil; pairFeedback = nil }
    /// Step 1: find the computer from its machine name (or full address) and confirm Sotto answers there:
    /// on 8443, where phone access serves it, then on 10000, where it serves it when another app holds
    /// 8443, then on 443.
    func find(_ typed: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard !working, storageReady else { return }; working = true; pairFeedback = nil
        let current = pairGeneration
        defer { if current == pairGeneration { working = false } }
        do {
            let candidates = try await HostFinder.candidates(typed)
            let finder = self.finder
            let hit = try await HostFinder.probe(candidates) { endpoint in try await finder.health(endpoint: endpoint) }
            guard current == pairGeneration else { return }
            if let existing = computer(hit.found.hostId) {
                pairFeedback = String(localized: "This iPhone is already paired with \(existing.name). To pair it again, remove it in Computers first.", comment: "%@ is the computer's name. Computers is the name of a tab")
                return
            }
            found = FoundHost(endpoint: hit.endpoint, health: hit.found)
        } catch { if current == pairGeneration { pairFeedback = error.localizedDescription } }
    }
    func changeComputer() { found = nil; pairFeedback = nil }
    /// Step 2: spend the code on the computer step 1 found.
    func pair(code typed: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard !working, storageReady, let found else { return }; working = true; pairFeedback = nil
        let current = pairGeneration
        do {
            let code = try PairingCode.normalized(typed)
            try keychain.checkWritable()
            // Kept even if the sheet closed or the app went to the background meanwhile: the code is spent
            // and the computer holds this client.
            let pairing = try await finder.pair(endpoint: found.endpoint, expectedHostID: found.health.hostId, code: code)
            let computer = SavedComputer(address: found.endpoint.url.absoluteString, pairing: pairing, reportedName: found.health.computerName)
            // Markers from an earlier pairing with this computer must never attach to the new client.
            let markers = pending.filter { $0.hostID != computer.hostID }
            var savedCredential = false
            do {
                try keychain.write(computer, account: ComputerStore.account(computer.hostID))
                savedCredential = true
                if let computerIndexAccount { try keychain.write(computers.map(\.hostID).filter { $0 != computer.hostID } + [computer.hostID], account: computerIndexAccount) }
                try keychain.write(markers, account: ComputerStore.pendingAccount)
            } catch {
                // Roll back before the network wait: Cancel can open another Add flow while
                // revocation waits, and that flow may save a newer pairing for this computer.
                if savedCredential {
                    try? keychain.remove(account: ComputerStore.account(computer.hostID))
                    if let computerIndexAccount { try? keychain.write(computers.map(\.hostID), account: computerIndexAccount) }
                }
                try? await finder.revoke(endpoint: found.endpoint, pairing: pairing)
                throw error
            }
            pending = markers
            computers = computers.filter { $0.hostID != computer.hostID } + [computer]
            live[computer.hostID] = Live()
            // Sheet state belongs to whichever Add computer is open now; a pairing that finishes after
            // Cancel is saved but leaves a newer sheet alone.
            if current == pairGeneration { self.found = nil; working = false; adding = false }
            await connect(computer.hostID)
        } catch { if current == pairGeneration { pairFeedback = error.localizedDescription; working = false } }
    }

    // MARK: Looking after a computer

    func rename(_ hostID: String, to typed: String) {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard var computer = self.computer(hostID) else { return }
        computer.localName = ComputerName.cleaned(typed)
        do {
            try keychain.write(computer, account: ComputerStore.account(hostID))
            computers = computers.map { $0.hostID == hostID ? computer : $0 }
        } catch { feedback = error.localizedDescription }
    }
    /// Revokes this iPhone on the computer where it can be reached, then forgets the computer here either way.
    func remove(_ hostID: String) async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        guard storageReady, removing == nil, let saved = computer(hostID) else { return }
        removing = hostID
        defer { removing = nil }
        var outcome = Revocation.confirmed
        if let endpoint = saved.endpoint {
            do { try await connection(hostID).revoke(endpoint: endpoint, pairing: saved.pairing) }
            catch is URLError { outcome = .unreachable }
            catch ClientError.hostUnreachable(_) { outcome = .unreachable }
            catch { outcome = .unconfirmed }
        } else { outcome = .unconfirmed }
        // The item goes first: an index entry without its item is skipped at launch, and markers for a
        // computer that isn't there are dropped then too, so the later writes can fail without harm.
        do { try keychain.remove(account: ComputerStore.account(hostID)) } catch { feedback = error.localizedDescription; return }
        let rest = computers.filter { $0.hostID != hostID }
        let markers = pending.filter { $0.hostID != hostID }
        if let computerIndexAccount { try? keychain.write(rest.map(\.hostID), account: computerIndexAccount) }
        try? keychain.write(markers, account: ComputerStore.pendingAccount)
        retries.removeValue(forKey: hostID)?.cancel(); retryAttempts[hostID] = nil; retryingSince[hostID] = nil; wasOnline.remove(hostID)
        generations[hostID] = UUID(); connecting.remove(hostID)
        connections[hostID]?.close(); connections[hostID] = nil
        let gone = Set(pending.filter { $0.hostID == hostID }.map(\.id))
        computers = rest; live[hostID] = nil; pending = markers; watches[hostID] = nil; watcherWatches[hostID] = nil; watcherStore.pages[hostID] = nil
        if chosenWatcherHost == hostID { chosenWatcherHost = nil }
        watcherDrafts[hostID] = nil; watcherSending[hostID] = nil; watcherSetAside[hostID] = nil; watcherStops[hostID] = nil; watcherReadProblems[hostID] = nil
        if selected?.hostID == hostID { cancelDetailReload(); selected = nil; openDetail = nil; detailProblem = nil }
        if detailStore.held?.ref.hostID == hostID { detailStore.held = nil }
        if show == .only(hostID) { show = .all }
        let prefix = hostID + "/"
        drafts = drafts.filter { !$0.key.hasPrefix(prefix) }
        failedReplies = failedReplies.filter { !$0.key.hasPrefix(prefix) }
        draftPhotos = draftPhotos.filter { !$0.key.hasPrefix(prefix) }
        failedPhotos = failedPhotos.filter { !$0.key.hasPrefix(prefix) }
        draftFiles = draftFiles.filter { !$0.key.hasPrefix(prefix) }
        failedFiles = failedFiles.filter { !$0.key.hasPrefix(prefix) }
        photoNotices = photoNotices.filter { !$0.key.hasPrefix(prefix) }
        submitted = submitted.filter { !gone.contains($0.key) }
        submittedPhotos = submittedPhotos.filter { !gone.contains($0.key) }
        submittedFiles = submittedFiles.filter { !gone.contains($0.key) }
        gone.forEach { dispatchingOperations[$0] = nil; receiptFollowers[$0] = nil }
        largeRequests[hostID] = nil
        let words = outcome.words(name: saved.name, clientID: saved.pairing.clientId)
        feedback = words
        // With nothing left paired the app goes back to the pairing steps, which show this instead.
        if rest.isEmpty { pairFeedback = words }
    }
    private enum Revocation {
        case confirmed, unreachable, unconfirmed
        func words(name: String, clientID: String) -> String {
            let command = Interface.isolated("--revoke-client \(clientID)")
            let there = String(localized: "Remove it there too: in Settings › Hosts & phones on \(name). For a computer without a screen, use Phones on its row in Settings › Hosts & phones on your main computer, or its \(command) command.", comment: "Settings › Hosts & phones and Phones name places in Sotto on the desktop. The first placeholder is the computer's name; the second is a command line, such as --revoke-client followed by an ID")
            switch self {
            case .confirmed: return String(localized: "Removed \(name).", comment: "%@ is the computer's name")
            case .unreachable:
                return String(localized: "Removed \(name) from this iPhone. It couldn’t be reached, so it still lists this iPhone.", comment: "%@ is the computer's name") + " " + there
            case .unconfirmed:
                return String(localized: "Removed \(name) from this iPhone, but couldn’t confirm removal there, so it may still list this iPhone.", comment: "%@ is the computer's name") + " " + there
            }
        }
    }

    // MARK: The open thread

    func select(_ ref: ThreadRef?) async {
        cancelDetailReload()
        let previous = selected
        // The thread let go of stays on screen if it is opened again, until a fresh copy is read; another thread
        // starts empty.
        holdDetail()
        if let ref, detailStore.held?.ref != ref { detailStore.held = nil }
        selected = ref; detailProblem = nil; detailVersion += 1
        let selection = UUID()
        threadSelectionGeneration = selection
        guard threadSelectionGeneration == selection, !Task.isCancelled else { return }
        #if DEBUG && os(iOS)
        if isUIFixture {
            let detail = ref.flatMap { fixtureDetails[$0.id] }
            if fixtureSlowDetail, let ref {
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard selected == ref else { return }
            }
            openDetail = detail
            if fixtureReconnecting, let ref, detail != nil {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard selected == ref else { return }
                // As `connect` does when a computer that was online is tried again: the thread as last read stays.
                holdDetail()
                update(ref.hostID) { $0.status = .connecting; $0.mayAnswer = false }
            }
            return
        }
        #endif
        if let previous, previous.hostID != ref?.hostID, online(previous.hostID), let before = connections[previous.hostID] {
            _ = try? await before.call(["op": .string("observe"), "threadIds": .array([])])
        }
        // Another thread may have been opened, or its computer reconnected, while the last one was let go.
        guard let ref, selected == ref, threadSelectionGeneration == selection, !Task.isCancelled, online(ref.hostID) else { return }
        let current = generations[ref.hostID]
        do { try await observeAndRead(ref.hostID) }
        catch { if generations[ref.hostID] == current, selected == ref { detailProblem = String(localized: "This thread could not be loaded. Nothing was lost. Try again.") } }
    }
    /// Tells one computer which of its threads is open here, and reads that thread.
    private func observeAndRead(_ hostID: String) async throws {
        guard let connection = connections[hostID], let current = generations[hostID] else { return }
        let ref = selected?.hostID == hostID ? selected : nil
        _ = try await connection.call(["op": .string("observe"), "threadIds": .array(ref.map { [.string($0.threadID)] } ?? [])])
        guard generations[hostID] == current, let ref, ref == selected else { return }
        // observe sends the initial detail before acknowledging. Do not download it twice.
        if openDetail?.threadId == ref.threadID { return }
        let version = detailVersion
        let next = try await connection.call(["op": .string("detail"), "threadId": .string(ref.threadID)], as: Optional<ThreadDetail>.self)
        try applyDetail(next, ref: ref, epoch: current, versionAtRead: version)
    }
    private func cancelDetailReload() {
        detailReload?.cancel(); detailReload = nil; detailReloadID = nil; detailWantedRevision = 0
    }
    /// Several deltas can arrive after a gap. One full read repairs the base for all of them.
    private func reloadDetail(_ ref: ThreadRef) {
        guard detailReload == nil, selected == ref, let connection = connections[ref.hostID], let epoch = generations[ref.hostID] else { return }
        let id = UUID(); detailReloadID = id
        let version = detailVersion
        detailReload = Task { [weak self] in
            guard let self else { return }
            var repeatRead = false
            defer {
                if detailReloadID == id {
                    detailReload = nil; detailReloadID = nil
                    if repeatRead { reloadDetail(ref) }
                }
            }
            do {
                let next = try await connection.call(["op": .string("detail"), "threadId": .string(ref.threadID)], as: Optional<ThreadDetail>.self)
                guard !Task.isCancelled else { return }
                try applyDetail(next, ref: ref, epoch: epoch, versionAtRead: version)
                // A newer delta may have arrived during the read/decode. Do not lose the final
                // update just because a repair was already in flight when it arrived.
                repeatRead = next != nil && selected == ref && generations[ref.hostID] == epoch
                    && (openDetail?.revision ?? 0) < detailWantedRevision
            } catch {
                if !Task.isCancelled, selected == ref, generations[ref.hostID] == epoch {
                    detailProblem = String(localized: "This thread could not be refreshed. Nothing was lost. Try again.")
                }
            }
        }
    }
    private func applyDetail(_ next: ThreadDetail?, ref: ThreadRef, epoch: UUID, versionAtRead: Int? = nil) throws {
        guard let now = generations[ref.hostID], epoch == now, ref == selected else { return }
        if let next, next.threadId != ref.threadID { throw ClientError.invalidIdentity }
        guard SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: now,
                                    requestedThread: ref.id, selectedThread: selected?.id,
                                    incomingRevision: next?.revision, currentRevision: openDetail?.revision,
                                    changedSinceRead: versionAtRead.map { $0 != detailVersion } ?? false) else { return }
        if let next, next.revision == openDetail?.revision { return }
        openDetail = next; detailVersion += 1
        if detailStore.held != nil { detailStore.held = nil }
        if detailProblem != nil { detailProblem = nil }
    }
    func earlier(_ ref: ThreadRef) async {
        guard online(ref.hostID), selected == ref, let connection = connections[ref.hostID] else { return }
        let current = generations[ref.hostID]
        do {
            let command = try Commands.loadEarlier(threadID: ref.threadID)
            _ = try await connection.call(["op": .string("command"), "command": command])
            guard generations[ref.hostID] == current, selected == ref else { return }
            try await observeAndRead(ref.hostID)
        } catch { if generations[ref.hostID] == current { feedback = error.localizedDescription } }
    }

    // MARK: Replies, answers and stops, each to its thread's own computer

    /// Sends the reply box: its words, its photos, or both. The reply is marked before it goes, and from the
    /// first press until then a second press finds nothing to send, so one reply is never sent twice.
    func send(_ ref: ThreadRef) async {
        guard canSendReply(ref), computer(ref.hostID) != nil else { return }
        // The words as pressed. The reply box is locked while its photos are staged, so nothing typed
        // after the press joins a reply already on its way.
        let text = drafts[ref.id] ?? ""
        var images: [StagedImage] = [], stagedFiles: [StagedFile] = []
        if !photos(ref).isEmpty || !files(ref).isEmpty {
            preparingSends.insert(ref.id)
            var ready: [StagedImage]? = []
            if !photos(ref).isEmpty { ready = await readyPhotos(.thread(ref)) }
            var readyFiles: [StagedFile]? = []
            if ready != nil, !files(ref).isEmpty { readyFiles = await self.readyFiles(ref) }
            preparingSends.remove(ref.id)
            guard let ready, let readyFiles else { return }
            images = ready; stagedFiles = readyFiles
        }
        // Nothing below waits until the marker is kept, so the checks hold when it is.
        guard canSend(ref), images.isEmpty || photoSupport(ref) == .available, stagedFiles.isEmpty || fileSupport(ref) == .available,
              let computer = self.computer(ref.hostID) else {
            if !images.isEmpty || !stagedFiles.isEmpty { photoNotices[ref.id] = String(localized: "Your reply wasn’t sent. It’s still in the reply box.") }
            return
        }
        let draft = UUID().uuidString
        // Read at the last moment: a turn that ended while the photos were staged takes the reply now, unqueued.
        let queuing = queuesReply(ref)
        do {
            let command = try queuing ? Commands.queue(threadID: ref.threadID, text: text, draftID: draft, images: images, files: stagedFiles)
                : Commands.prompt(threadID: ref.threadID, text: text, draftID: draft, images: images, files: stagedFiles)
            let operation = PendingOperation(hostID: ref.hostID, clientID: computer.pairing.clientId, threadID: ref.threadID,
                                             draftID: draft, kind: queuing ? "queue" : "reply")
            try remember(operation); submitted[operation.id] = text; drafts[ref.id] = ""
            if !images.isEmpty { submittedPhotos[operation.id] = photos(ref); photosSent?(photos(ref), ref); draftPhotos[ref.id] = nil }
            if !stagedFiles.isEmpty { submittedFiles[operation.id] = files(ref); draftFiles[ref.id] = nil }
            photoNotices[ref.id] = nil
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }

    // MARK: Photos in the reply box

    func attachPhotos(_ ref: ThreadRef, from sources: [PhotoSource]) { attachPhotos(.thread(ref), from: sources) }
    func removePhoto(_ id: UUID, from ref: ThreadRef) { removePhoto(id, from: .thread(ref)) }
    /// Adds photos to a reply box. Each is prepared off the main actor and staged on the box's computer in the
    /// order chosen, one at a time, so several large photos are never held decoded at once.
    func attachPhotos(_ box: PhotoBox, from sources: [PhotoSource]) {
        guard !sources.isEmpty, photoSupport(box) == .available, !preparingSends.contains(box.id) else { return }
        // Files count toward the eight (ADR-0131).
        let room = PhotoLimits.count - photos(box).count - files(box).count
        guard room > 0 else { photoNotices[box.id] = files(box).isEmpty ? box.photoLimitWords : FileWords.full; return }
        let added = sources.prefix(room).map { (photo: DraftPhoto(), source: $0) }
        draftPhotos[box.id, default: []] += added.map { $0.photo }
        let others = files(box).isEmpty ? box.photoLimitOthersWords : FileWords.othersNotAdded
        photoNotices[box.id] = sources.count > room ? others : nil
        let previous = photoWork
        photoWork = Task { [weak self] in
            await previous?.value
            for item in added { await self?.prepare(item.photo.id, in: box, from: item.source) }
        }
    }
    func removePhoto(_ id: UUID, from box: PhotoBox) {
        guard !preparingSends.contains(box.id) else { return }
        dropPhoto(id, in: box, reason: nil)
    }
    private func prepare(_ id: UUID, in box: PhotoBox, from source: PhotoSource) async {
        // Removed while it waited its turn: nothing is read.
        guard photo(id, in: box) != nil else { return }
        do {
            let prepared = try await preparePhoto(try await loaded(source.load, for: id), source.name)
            guard photo(id, in: box) != nil else { return }
            let others = photos(box).filter { $0.id != id }.compactMap { $0.prepared?.byteCount }
            guard Photos.fits(prepared.byteCount, with: others) else {
                throw ClientError.rejected(box.photosTooLargeWords)
            }
            guard others.reduce(prepared.byteCount, +) + files(box).map(\.sizeBytes).reduce(0, +) <= FileLimits.bytesTogether else {
                throw ClientError.rejected(FileWords.tooLargeInTotal)
            }
            change(id, in: box) { $0.prepared = prepared }
            // Staged on its own, so a slow computer never holds up preparing photos for any other reply.
            _ = staging(id, in: box)
        } catch {
            // A photo the library couldn't hand over reads as one that couldn't be read.
            let reason = (error as? PhotoPipelineError)?.errorDescription ?? (error as? ClientError)?.errorDescription
            dropPhoto(id, in: box, reason: reason ?? PhotoPipelineError.unreadable.errorDescription!)
        }
    }
    /// A photo's original bytes, or `tooSlow` once the limit passes, so one that never arrives can't hold up the
    /// photos chosen after it, and removing the photo ends the wait at once. A load that ignores cancellation is
    /// left to finish on its own.
    private func loaded(_ load: @escaping @Sendable () async throws -> Data, for id: UUID) async throws -> Data {
        let waiting = PhotoLoad()
        photoLoads[id] = waiting
        defer { photoLoads[id] = nil }
        let limit = photoLoadLimit
        return try await withCheckedThrowingContinuation { continuation in
            waiting.continuation = continuation
            waiting.tasks = [
                Task { do { waiting.finish(.success(try await load())) } catch { waiting.finish(.failure(error)) } },
                Task { do { try await limit(); waiting.finish(.failure(PhotoPipelineError.tooSlow)) } catch {} },
            ]
        }
    }
    /// A photo's staging, started now unless it is already under way: a photo is never staged twice at once.
    private func staging(_ id: UUID, in box: PhotoBox) -> Task<Bool, Never>? {
        if let running = stagingTasks[id] { return running }
        guard let prepared = photo(id, in: box)?.prepared else { return nil }
        change(id, in: box) { $0.staging = true }
        let task = Task { [weak self] () -> Bool in
            let staged = await self?.requestStaging(prepared, as: id, in: box) ?? false
            self?.stagingTasks[id] = nil
            self?.change(id, in: box) { $0.staging = false }
            return staged
        }
        stagingTasks[id] = task
        return task
    }
    private func stage(_ id: UUID, in box: PhotoBox) async -> Bool { await staging(id, in: box)?.value ?? false }
    /// Stages one prepared photo on its thread's computer. A photo that couldn't reach it stays in the box and
    /// is staged when the reply is sent; one the computer refused for what it is leaves the box, with its reason.
    private func requestStaging(_ prepared: PreparedPhoto, as id: UUID, in box: PhotoBox) async -> Bool {
        let over = generations[box.hostID]
        do {
            let operation = try Photos.stage(name: prepared.name, mimeType: prepared.mimeType, base64: prepared.base64, dimensions: prepared.dimensions)
            let handle = try await largeRequest(on: box.hostID) { connection -> StagedImage in
                let handle = try await connection.call(operation, as: StagedImage.self)
                guard handle.valid else { throw ClientError.invalidProtocol }
                return handle
            }
            change(id, in: box) { $0.staged = handle; $0.stagedAt = Date(); $0.stagedGeneration = over }
            return true
        } catch let refusal as HostRefusal where refusal.failure.code == "invalid_request" {
            dropPhoto(id, in: box, reason: refusal.failure.message)
        } catch {}
        return false
    }
    /// Every photo in the reply box with a handle its computer still keeps: staged now if it never got there,
    /// or again if it has been there long enough to be let go. Nil, with the reason, when one can't be.
    private func readyPhotos(_ box: PhotoBox) async -> [StagedImage]? {
        // Only this reply's own photos are waited for: one still on its way is joined, not sent again.
        // Each photo is read as it is now, not as it was when the loop began: one staged meanwhile is not staged again.
        for id in photos(box).map(\.id) {
            // One that left the box while the reply waited, refused by the computer, makes it a reply the user
            // didn't press: nothing is sent, and the box says why.
            guard let photo = photo(id, in: box) else { return nil }
            guard stagingTasks[id] != nil || photo.needsStaging(generation: generations[box.hostID]) else { continue }
            guard await stage(id, in: box) else {
                if photoNotices[box.id] == nil {
                    photoNotices[box.id] = String(localized: "A photo couldn’t reach \(name(box.hostID)), so nothing was sent. Try again when it’s connected.", comment: "%@ is the computer's name")
                }
                return nil
            }
        }
        let current = photos(box)
        let staged = current.compactMap(\.staged)
        return !staged.isEmpty && staged.count == current.count ? staged : nil
    }
    private func photo(_ id: UUID, in box: PhotoBox) -> DraftPhoto? { draftPhotos[box.id]?.first { $0.id == id } }
    private func change(_ id: UUID, in box: PhotoBox, _ edit: (inout DraftPhoto) -> Void) {
        guard let index = draftPhotos[box.id]?.firstIndex(where: { $0.id == id }) else { return }
        edit(&draftPhotos[box.id]![index])
    }
    /// Takes a photo out of its reply box, saying why when it wasn't the user's choice.
    private func dropPhoto(_ id: UUID, in box: PhotoBox, reason: String?) {
        guard photo(id, in: box) != nil else { return }
        photoLoads[id]?.finish(.failure(CancellationError()))
        draftPhotos[box.id]?.removeAll { $0.id == id }
        if draftPhotos[box.id]?.isEmpty == true { draftPhotos[box.id] = nil }
        photoNotices[box.id] = reason
    }
    /// One large request at a time on each computer: it refuses a second image, either way, while one is on
    /// its way. Each waits for the one before it, whether that one worked or not.
    private func largeRequest<T: Sendable>(on hostID: String, _ work: @escaping @MainActor (HostConnection) async throws -> T) async throws -> T {
        let previous = largeRequests[hostID]
        let task = Task<T, Error> { [weak self] in
            await previous?.value
            guard let self, self.online(hostID), let connection = self.connections[hostID] else { throw ClientError.disconnected }
            return try await work(connection)
        }
        largeRequests[hostID] = Task { _ = try? await task.value }
        return try await task.value
    }
    // MARK: Files in the reply box (ADR-0131)

    /// Adds files to a thread's reply box. As on the desktop, nothing is attached when one is past the host's limits, and
    /// that is decided by the sizes the Files app gives, before any is read. Each is then read into memory and staged on the
    /// thread's computer in the order chosen, one at a time.
    func attachFiles(_ ref: ThreadRef, from sources: [FileSource]) {
        guard !sources.isEmpty, fileSupport(ref) == .available, !preparingSends.contains(ref.id) else { return }
        let others = photos(ref).map { $0.prepared?.byteCount ?? 0 } + files(ref).map(\.sizeBytes)
        if let refusal = Files.refusal(adding: sources.map { $0.sizeBytes ?? 0 }, to: others) { photoNotices[ref.id] = refusal; return }
        let added = sources.map { (file: DraftFile(name: $0.name, mimeType: Files.mimeType(forName: $0.name), sizeBytes: $0.sizeBytes ?? 0), source: $0) }
        draftFiles[ref.id, default: []] += added.map { $0.file }
        photoNotices[ref.id] = nil
        let previous = fileWork
        fileWork = Task { [weak self] in
            await previous?.value
            for item in added { await self?.readFile(item.file.id, in: ref, from: item.source) }
        }
    }
    func removeFile(_ id: UUID, from ref: ThreadRef) {
        guard !preparingSends.contains(ref.id) else { return }
        dropFile(id, in: ref, reason: nil)
    }
    private func readFile(_ id: UUID, in ref: ThreadRef, from source: FileSource) async {
        // Removed while it waited its turn: nothing is read.
        guard file(id, in: ref) != nil else { return }
        do {
            let bytes = try await loaded(source.load, for: id)
            guard file(id, in: ref) != nil else { return }
            guard !bytes.isEmpty else { throw ClientError.rejected(FileWords.empty) }
            let others = photos(ref).compactMap { $0.prepared?.byteCount } + files(ref).filter { $0.id != id }.map(\.sizeBytes)
            // The size the Files app gave may not have been the file's own.
            if let refusal = Files.refusal(adding: [bytes.count], to: others) { throw ClientError.rejected(refusal) }
            let digest = await Task.detached { Files.digest(bytes) }.value
            changeFile(id, in: ref) { $0.bytes = bytes; $0.sizeBytes = bytes.count; $0.digest = digest }
            // Staged on its own, so a slow computer never holds up reading the files chosen after it.
            _ = fileStaging(id, in: ref)
        } catch {
            let reason = (error as? PhotoPipelineError) == .tooSlow ? FileWords.tooSlow : (error as? ClientError)?.errorDescription
            dropFile(id, in: ref, reason: reason ?? FileWords.unreadable)
        }
    }
    /// A file's staging, started now unless it is already under way: a file is never staged twice at once.
    private func fileStaging(_ id: UUID, in ref: ThreadRef) -> Task<Bool, Never>? {
        if let running = fileStagingTasks[id] { return running }
        guard let file = file(id, in: ref), let bytes = file.bytes, let digest = file.digest else { return nil }
        changeFile(id, in: ref) { $0.progress = 0 }
        let task = Task { [weak self] () -> Bool in
            let staged = await self?.requestFileStaging(file.name, mimeType: file.mimeType, bytes: bytes, digest: digest, as: id, in: ref) ?? false
            self?.fileStagingTasks[id] = nil
            self?.changeFile(id, in: ref) { $0.progress = nil }
            return staged
        }
        fileStagingTasks[id] = task
        return task
    }
    /// Stages one file on its thread's computer with `stage-file-part`, its parts in order as one large request, so no other
    /// upload on this iPhone comes between them: the computer keeps one upload a client. The last part's answer is the
    /// handle. A file that couldn't reach the computer stays in the box and is staged when the reply is sent; one the
    /// computer refused for what it is leaves the box, with its reason.
    private func requestFileStaging(_ name: String, mimeType: String, bytes: Data, digest: String, as id: UUID, in ref: ThreadRef) async -> Bool {
        let over = generations[ref.hostID]
        let ranges = Files.partRanges(bytes.count), upload = UUID()
        do {
            let handle = try await largeRequest(on: ref.hostID) { [weak self] connection -> StagedFile in
                for (index, range) in ranges.enumerated() {
                    // A file removed while it goes stops going; the computer lets the parts it has go.
                    guard self?.file(id, in: ref) != nil else { throw CancellationError() }
                    let operation = try await Task.detached {
                        try Files.stagePart(uploadID: upload, index: index, count: ranges.count, name: name, mimeType: mimeType,
                                            sizeBytes: bytes.count, digest: digest, data: bytes.subdata(in: range))
                    }.value
                    let answer = try await connection.call(operation, as: Optional<StagedFile>.self)
                    self?.changeFile(id, in: ref) { $0.progress = Double(index + 1) / Double(ranges.count) }
                    guard index == ranges.count - 1 else { if answer != nil { throw ClientError.invalidProtocol }; continue }
                    guard let answer, answer.valid, answer.digest == digest, answer.sizeBytes == bytes.count else { throw ClientError.invalidProtocol }
                    return answer
                }
                throw ClientError.invalidProtocol
            }
            changeFile(id, in: ref) { $0.staged = handle; $0.stagedAt = Date(); $0.stagedGeneration = over }
            return true
        } catch let refusal as HostRefusal where refusal.failure.code == "invalid_request" {
            dropFile(id, in: ref, reason: refusal.failure.message)
        } catch {}
        return false
    }
    /// Every file in the reply box with a handle its computer still keeps, as `readyPhotos` does for photos.
    private func readyFiles(_ ref: ThreadRef) async -> [StagedFile]? {
        for id in files(ref).map(\.id) {
            guard let file = file(id, in: ref) else { return nil }
            guard fileStagingTasks[id] != nil || file.needsStaging(generation: generations[ref.hostID]) else { continue }
            guard await fileStaging(id, in: ref)?.value ?? false else {
                if photoNotices[ref.id] == nil {
                    photoNotices[ref.id] = String(localized: "A file couldn’t reach \(name(ref.hostID)), so nothing was sent. Try again when it’s connected.", comment: "%@ is the computer's name")
                }
                return nil
            }
        }
        let current = files(ref)
        let staged = current.compactMap(\.staged)
        return !staged.isEmpty && staged.count == current.count ? staged : nil
    }
    private func file(_ id: UUID, in ref: ThreadRef) -> DraftFile? { draftFiles[ref.id]?.first { $0.id == id } }
    private func changeFile(_ id: UUID, in ref: ThreadRef, _ edit: (inout DraftFile) -> Void) {
        guard let index = draftFiles[ref.id]?.firstIndex(where: { $0.id == id }) else { return }
        edit(&draftFiles[ref.id]![index])
    }
    /// Takes a file out of its reply box, saying why when it wasn't the user's choice.
    private func dropFile(_ id: UUID, in ref: ThreadRef, reason: String?) {
        guard file(id, in: ref) != nil else { return }
        photoLoads[id]?.finish(.failure(CancellationError()))
        draftFiles[ref.id]?.removeAll { $0.id == id }
        if draftFiles[ref.id]?.isEmpty == true { draftFiles[ref.id] = nil }
        photoNotices[ref.id] = reason
    }
    /// A sent file's bytes from the computer that keeps it, for Quick Look (`attachment-file`): part by part, each waiting
    /// its turn behind other large requests to that computer, and none asked for once nothing `wanted` it. The parts must
    /// make the file their first one named, its size and digest, or none of it is kept.
    func sentFile(_ ref: ThreadRef, messageID: String, attachmentID: String, progress: @escaping @MainActor (Double) -> Void,
                  wanted: @escaping @MainActor () -> Bool) async -> SentFileOutcome {
        guard opensSentFiles(ref.hostID) else { return .failed }
        var assembly: SentFileAssembly?
        repeat {
            let operation = Files.open(threadID: ref.threadID, messageID: messageID, attachmentID: attachmentID, part: assembly?.received ?? 0)
            let part: SentFilePart?
            do {
                part = try await largeRequest(on: ref.hostID) { connection -> SentFilePart? in
                    guard wanted() else { throw CancellationError() }
                    return try await connection.call(operation, as: Optional<SentFilePart>.self)
                }
            } catch { return .failed }
            guard let part else { return assembly == nil ? .notKept : .failed }
            let before = assembly
            let next = await Task.detached { () -> SentFileAssembly? in
                guard var whole = before else { return SentFileAssembly(first: part) }
                return whole.add(part) ? whole : nil
            }.value
            guard let next else { return .failed }
            assembly = next
            progress(next.progress)
        } while assembly?.complete == false
        guard let assembly, let data = await Task.detached(operation: { assembly.finish() }).value else { return .failed }
        return .file(name: assembly.name, data: data)
    }
    /// A sent photo's bytes from the computer that keeps it. It waits its turn behind other large requests to
    /// that computer, and is never made if nothing on screen still `wanted` it by then.
    func sentPhoto(_ ref: ThreadRef, messageID: String, attachmentID: String, wanted: @escaping @MainActor () -> Bool) async -> Data? {
        // Watcher's thread is never one of this iPhone's own to read: its photos come through Watcher's page.
        let operation: [String: JSONValue]
        if let watcher = watcherPage(ref.hostID)?.current?.target, watcher.threadId == ref.threadID,
           live[ref.hostID]?.features.contains(WatcherWire.photosFeature) == true {
            operation = WatcherWire.preview(target: watcher, messageID: messageID, attachmentID: attachmentID)
        } else {
            operation = Photos.preview(threadID: ref.threadID, messageID: messageID, attachmentID: attachmentID)
        }
        guard let url = try? await largeRequest(on: ref.hostID, { connection -> String? in
            guard wanted() else { return nil }
            return try await connection.call(operation, as: Optional<PhotoPreview>.self)?.dataUrl
        }) else { return nil }
        return await Photos.bytes(fromDataURL: url)
    }
    /// Answers a request from the open thread's sheet, after rechecking the computer's authority.
    func answer(_ request: AgentRequest, in ref: ThreadRef, choice: String? = nil, text: String = "", answers: [String: QuestionAnswer] = [:]) async {
        guard let thread = self.thread(ref), canAnswer(request, in: ref), let computer = self.computer(ref.hostID) else { return }
        do {
            let command = try Commands.answer(threadID: ref.threadID, request: request, currentRequests: thread.requests, choice: choice, text: text, answers: answers)
            #if DEBUG && os(iOS)
            if isUIFixture { try settleFixtureAnswer(request, in: ref); return }
            #endif
            let operation = PendingOperation(hostID: ref.hostID, clientID: computer.pairing.clientId, threadID: ref.threadID, requestID: request.id, kind: "answer")
            try remember(operation)
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    func interrupt(_ ref: ThreadRef) async {
        guard canInterrupt(ref), let computer = self.computer(ref.hostID) else { return }
        do {
            let command = try Commands.interrupt(threadID: ref.threadID)
            let operation = PendingOperation(hostID: ref.hostID, clientID: computer.pairing.clientId, threadID: ref.threadID, kind: "interrupt")
            try remember(operation)
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    /// Sends a queued message now instead of after the running turn. Like a stop, it is marked before it goes and never resent.
    func steer(_ item: Followup, in ref: ThreadRef) async {
        guard canSteer(item, in: ref) else { return }
        await act(on: ref, kind: "steer") { try Commands.steerFollowup(threadID: ref.threadID, itemID: item.id) }
    }
    /// Takes a queued message out of the queue unsent.
    func removeFollowup(_ item: Followup, in ref: ThreadRef) async {
        guard canRemove(item, in: ref) else { return }
        await act(on: ref, kind: "remove") { try Commands.removeFollowup(threadID: ref.threadID, itemID: item.id) }
    }
    /// Asks the thread's provider to compact its context.
    func compact(_ ref: ThreadRef) async {
        guard canAct(on: ref), compactionOffered(ref), compactionHeld(ref) == nil else { return }
        await act(on: ref, kind: "compact") { try Commands.compact(threadID: ref.threadID) }
    }
    /// One of the thread's own commands, marked by its kind and thread alone before it goes.
    private func act(on ref: ThreadRef, kind: String, _ build: () throws -> JSONValue) async {
        guard let computer = self.computer(ref.hostID) else { return }
        do {
            let command = try build()
            let operation = PendingOperation(hostID: ref.hostID, clientID: computer.pairing.clientId, threadID: ref.threadID, kind: kind)
            try remember(operation)
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    private func remember(_ operation: PendingOperation) throws {
        guard pending.count < 100 else { throw ClientError.rejected(String(localized: "Check the unconfirmed actions before sending more.")) }
        let next = pending + [operation]; try keychain.write(next, account: ComputerStore.pendingAccount); pending = next
    }
    private func forgetMarker(_ id: String) throws {
        let next = pending.filter { $0.id != id }; try keychain.write(next, account: ComputerStore.pendingAccount); pending = next
        submitted.removeValue(forKey: id); submittedPhotos.removeValue(forKey: id); submittedFiles.removeValue(forKey: id)
    }
    @discardableResult private func dispatch(_ command: JSONValue, operation: PendingOperation) async -> Shell? {
        let hostID = operation.hostID, current = generations[hostID]
        let earlierError = live[hostID]?.shell?.error
        // From here, which follows its marker without a wait, until this returns, it reads as sending;
        // a marker still kept after that is unconfirmed.
        dispatchingOperations[operation.id] = .some(current)
        defer { dispatchingOperations[operation.id] = nil }
        guard let connection = connections[hostID] else { operationFeedback(ClientError.uncertain.localizedDescription, operations: [operation.id]); return nil }
        do {
            let result = try await connection.callReceived(["op": .string("command"), "command": command], as: Shell.self, id: operation.id)
            guard generations[hostID] == current else { return nil }
            let next = result.value
            try applyShell(next, from: hostID, sequence: result.sequence, reconcileAnswers: false)
            await checkDelivery(hostID)
            guard generations[hostID] == current else { return nil }
            if let error = next.error {
                if operation.kind.hasPrefix("create-") { creationFeedback = error }
                // The shell's error is the computer's last one; only one that is new is this command's.
                if Self.queueActionKinds.contains(operation.kind), error != earlierError { feedback = error }
                return nil
            }
            return next
        } catch let error as HostRefusal {
            guard generations[hostID] == current else { return nil }
            // Revocation can replace an acknowledgement AFTER the action ran.
            // Generic unavailable failures may also follow provider side effects.
            if ["invalid_request", "stale_request", "forbidden", "busy"].contains(error.failure.code) {
                do { try rejectOperation(operation) } catch { feedback = error.localizedDescription; return nil }
            }
            if error.failure.code == "forbidden" { update(hostID) { $0.mayAnswer = false } }
            if error.failure.code == "unauthenticated" { update(hostID) { $0.status = .unreachable; $0.problem = error.localizedDescription } }
            feedback = error.localizedDescription
        } catch {
            guard generations[hostID] == current else { return nil }
            // A slow provider can outlast the acknowledgement's deadline. While the computer says it is still
            // carrying the command out, it is still sending; either way it is never sent again.
            if Self.sendingKinds.contains(operation.kind), let token = claimReceipt(operation.id, over: current) {
                await followReceipt(operation, on: connection, epoch: current, token: token)
            }
            if generations[hostID] == current, pending.contains(where: { $0.id == operation.id }) {
                operationFeedback(String(localized: "Delivery is unconfirmed. Reconnect and check the thread before sending again."), operations: [operation.id])
            }
        }
        return nil
    }
    /// Reads a command's receipt every two seconds while its computer says it is still carrying it out, and
    /// settles it once it has finished. A computer that doesn't know the command, a changed connection or the last
    /// read, about ten minutes on, leave it as it is: unconfirmed.
    private func followReceipt(_ operation: PendingOperation, on connection: HostConnection, epoch: UUID?, token: UUID) async {
        defer { if receiptFollowers[operation.id]?.token == token { receiptFollowers[operation.id] = nil } }
        let hostID = operation.hostID
        for _ in 0..<Self.receiptReads {
            guard receiptFollowers[operation.id]?.token == token, generations[hostID] == epoch, online(hostID),
                  pending.contains(where: { $0.id == operation.id }),
                  let receipt = try? await connection.call(["op": .string("receipt"), "commandId": .string(operation.id)], as: Receipt.self),
                  generations[hostID] == epoch else { return }
            guard receipt.stillWorking else {
                if receipt.status == "completed" { await checkDelivery(hostID) }
                return
            }
            do { try await receiptSleep(Self.receiptInterval) } catch { return }
        }
    }
    /// Claims a command's receipt for this connection generation, unless it is already followed over it.
    private func claimReceipt(_ id: String, over generation: UUID?) -> UUID? {
        guard receiptFollowers[id].map({ $0.generation != generation }) ?? true else { return nil }
        let token = UUID()
        receiptFollowers[id] = ReceiptFollower(token: token, generation: generation)
        return token
    }
    func checkDelivery(_ hostID: String) async {
        guard online(hostID), !scoped(hostID).isEmpty, let connection = connections[hostID] else { return }
        let current = generations[hostID]
        deliveryChecks[hostID, default: 0] += 1
        defer { deliveryChecks[hostID, default: 0] -= 1 }
        do {
            let fresh = try await connection.callReceived(["op": .string("shell")], as: Shell.self)
            guard generations[hostID] == current else { return }
            let next = fresh.value
            try applyShell(next, from: hostID, sequence: fresh.sequence, reconcileAnswers: false)
            for item in scoped(hostID) {
                let receipt = try await connection.call(["op": .string("receipt"), "commandId": .string(item.id)], as: Receipt.self)
                guard generations[hostID] == current else { return }
                guard scoped(hostID).contains(where: { $0.id == item.id }) else { continue }
                try settle(item, receipt: receipt, shell: live[hostID]?.shell)
                // Still being carried out after a reconnect: claimed now, so it reads as sending from here
                // until its receipt settles it.
                // A dispatch on an older connection doesn't hold it: its own follower stops once the connection changes.
                if receipt.stillWorking, Self.sendingKinds.contains(item.kind), dispatchingOperations[item.id] != .some(current),
                   scoped(hostID).contains(where: { $0.id == item.id }),
                   let token = claimReceipt(item.id, over: current) {
                    Task { [weak self] in await self?.followReceipt(item, on: connection, epoch: current, token: token) }
                }
            }
        } catch {
            if generations[hostID] == current {
                operationFeedback(String(localized: "Delivery to \(name(hostID)) could not be checked. Nothing was resent. Reconnect to try again.", comment: "%@ is the computer's name"),
                                  operations: Set(scoped(hostID).map(\.id)))
            }
        }
    }
    private func operationFeedback(_ words: String, operations: Set<String>) {
        feedback = words; feedbackOperations = operations
    }
    private func settle(_ item: PendingOperation, receipt: Receipt? = nil, shell: Shell?) throws {
        // An answer from a card in Watcher's page: its own receipt confirms it, and a card that left Watcher's page is no
        // longer waiting. The thread may not be in this iPhone's list at all, Watcher's own included.
        if item.kind == "watcher-answer" {
            let confirmed = receipt?.confirmsAnswer == true
            let page = watcherStore.pages[item.hostID]
            let gone = page.map { page in !page.needsYou.contains { $0.target.threadId == item.threadID && $0.request.id == item.requestID } } ?? false
            guard confirmed || gone else { return }
            if confirmed, let request = item.requestID { confirmedAnswers.insert(item.hostID + "/" + item.threadID + "/" + request) }
            try forgetMarker(item.id)
            if feedback == nil || feedbackOperations.contains(item.id) {
                feedback = confirmed ? String(localized: "Answer sent.", comment: "Said once the computer confirms the user's answer to a request") : Self.requestNoLongerWaiting
            }
            return
        }
        // A phone-minted Sotto ID identifies this exact creation even after its receipt expired.
        if item.kind == "create-thread", shell?.host.threads.contains(where: { $0.id == item.threadID }) == true {
            try forgetMarker(item.id)
            return
        }
        let delivery = shell?.deliveries?.first { $0.threadId == item.threadID && $0.draftId == item.draftID }
        let delivered = shell?.deliveredDrafts?.contains { $0.threadId == item.threadID && $0.draftId == item.draftID } == true
        let accepted = delivered || delivery?.status == "accepted"
        let thread = shell?.host.threads.first { $0.id == item.threadID }
        // A queued reply is confirmed by the queue holding it, whatever became of it after.
        if item.kind == "queue", let shell, let draft = item.draftID, FollowupQueue.holds(shell, threadID: item.threadID, draftID: draft) {
            try forgetMarker(item.id)
            if feedbackOperations.remove(item.id) != nil, feedbackOperations.isEmpty { feedback = nil }
            return
        }
        // Only this command's own receipt confirms the phone's answer. A request can also leave
        // after a desktop answer, a stopped turn or provider cancellation.
        let noLongerWaiting = item.kind == "answer" && item.requestID != nil && shell != nil
            && (thread == nil || thread?.requests.contains(where: { $0.id == item.requestID }) == false)
        if item.kind == "answer" {
            let confirmed = receipt?.confirmsAnswer == true
            guard confirmed || noLongerWaiting else { return }
            if confirmed, let request = item.requestID { confirmedAnswers.insert(item.hostID + "/" + item.threadID + "/" + request) }
            try forgetMarker(item.id)
            if feedback == nil || feedbackOperations.contains(item.id) {
                feedback = confirmed ? String(localized: "Answer sent.", comment: "Said once the computer confirms the user's answer to a request") : Self.requestNoLongerWaiting
            }
        } else if delivery?.status == "failed" {
            try rejectOperation(item)
            // Named, because the thread open now may be another one, on another computer.
            let queued = item.kind == "queue"
            if let title = thread?.title {
                feedback = queued
                    ? String(localized: "Your reply to “\(title)” on \(name(item.hostID)) wasn’t queued. Its text is back in that thread.", comment: "The first placeholder is the thread's title; the second is the computer's name")
                    : String(localized: "Your reply to “\(title)” on \(name(item.hostID)) wasn’t sent. Its text is back in that thread.", comment: "The first placeholder is the thread's title; the second is the computer's name")
            } else {
                feedback = queued
                    ? String(localized: "Your reply to a thread on \(name(item.hostID)) wasn’t queued. Its text is back in that thread.", comment: "%@ is the computer's name")
                    : String(localized: "Your reply to a thread on \(name(item.hostID)) wasn’t sent. Its text is back in that thread.", comment: "%@ is the computer's name")
            }
        } else if accepted || receipt.map({ item.reconciled(receipt: $0, deliveries: shell?.deliveries ?? []) }) == true {
            try forgetMarker(item.id)
            if feedbackOperations.remove(item.id) != nil, feedbackOperations.isEmpty { feedback = nil }
        }
    }
    private func rejectOperation(_ operation: PendingOperation) throws {
        if let text = submitted[operation.id], operation.kind == "reply" || operation.kind == "queue" {
            let ref = ThreadRef(hostID: operation.hostID, threadID: operation.threadID)
            failedReplies[ref.id] = text
            failedPhotos[ref.id] = submittedPhotos[operation.id]
            failedFiles[ref.id] = submittedFiles[operation.id]
        }
        try forgetMarker(operation.id)
    }
    func restoreReply(_ ref: ThreadRef) {
        guard (drafts[ref.id] ?? "").isEmpty, photos(ref).isEmpty, files(ref).isEmpty, let text = failedReplies[ref.id] else { return }
        drafts[ref.id] = text; failedReplies.removeValue(forKey: ref.id)
        // Its photos come back too; any the computer may have let go are staged again when it is sent.
        // Staged again when sent: the computer may have refused it because it no longer kept a photo.
        if let photos = failedPhotos.removeValue(forKey: ref.id), !photos.isEmpty {
            draftPhotos[ref.id] = photos.map { var photo = $0; photo.staged = nil; photo.stagedAt = nil; return photo }
        }
        if let files = failedFiles.removeValue(forKey: ref.id), !files.isEmpty {
            draftFiles[ref.id] = files.map { var file = $0; file.staged = nil; file.stagedAt = nil; return file }
        }
    }
    func acknowledgeUnknown(_ id: String) {
        do { try forgetMarker(id); feedback = String(localized: "Unconfirmed action dismissed. Nothing was resent.") }
        catch { feedback = error.localizedDescription }
    }

    // MARK: New threads on one computer

    var pendingCreations: [PendingOperation] {
        pending.filter { item in
            item.kind.hasPrefix("create-") && computer(item.hostID).map { item.matches(hostID: $0.hostID, clientID: $0.pairing.clientId) } == true
        }
    }
    func creationModels(_ hostID: String) -> [ThreadModel] {
        guard let host = live[hostID]?.shell?.host else { return [] }
        return NewThreads.availableModels(host)
    }
    /// The new-thread defaults kept on this iPhone (ADR-0051).
    var newThreadDefaults: NewThreadDefaults {
        NewThreadDefaults(modelID: preferences.newThreadModel, effort: preferences.newThreadEffort,
                          permissionID: preferences.newThreadPermission,
                          workingCopy: preferences.newThreadWorkingCopy.flatMap { WorkingCopy(rawValue: $0.rawValue) })
    }
    func initialCreationModelID(_ hostID: String) -> String {
        live[hostID]?.shell.map { NewThreads.startingModelID($0, defaults: newThreadDefaults) } ?? ""
    }
    func initialCreationEffort(_ hostID: String, model: ThreadModel) -> String {
        live[hostID]?.shell.map { NewThreads.startingEffort(model, shell: $0, defaults: newThreadDefaults) } ?? model.startingEffort
    }
    /// The permission New thread starts on. A default that would let the thread act without asking waits for
    /// Can answer on that computer (ADR-0033); until then the thread starts by asking.
    func initialCreationPermission(_ hostID: String, model: ThreadModel) -> StartingPermission {
        NewThreads.startingPermission(model, defaults: newThreadDefaults, mayAnswer: mayAnswer(hostID))
    }
    var initialCreationWorkingCopy: WorkingCopy { NewThreads.startingWorkingCopy(newThreadDefaults) }
    /// The ready models of every computer this iPhone can reach, each once, for the new-thread defaults.
    var defaultModelChoices: [ThreadModel] {
        NewThreads.catalogUnion(computers.compactMap { online($0.hostID) ? live[$0.hostID]?.shell?.host : nil })
    }
    func projects(_ hostID: String) -> [Project] {
        (live[hostID]?.shell?.host.projects ?? []).filter { $0.workspaceSettledAt == nil }
    }
    func canBrowseFolders(_ hostID: String) -> Bool { online(hostID) && live[hostID]?.features.contains("host-folders") == true }
    func folders(_ hostID: String, path: JSONValue? = nil) async throws -> FolderResult {
        #if DEBUG && os(iOS)
        if isUIFixture {
            if ProcessInfo.processInfo.arguments.contains("--ui-folder-timeout") { throw ClientError.readTimedOut }
            let target = path?.string ?? "D:\\Engineering"
            let top = path == .null
            let children: [[String: Any]] = top ? [["name": "D:", "path": "D:\\", "git": false]]
                : target == "D:\\New project" ? [] : [["name": "New project", "path": "D:\\New project", "git": true], ["name": "Panel tools", "path": "D:\\Engineering\\Panel tools", "git": false]]
            let json: [String: Any] = ["status": "listed", "path": top ? NSNull() : target as Any, "home": "D:\\Engineering", "separator": "\\",
                "crumbs": top ? [["name": "Drives", "path": NSNull()]] : [["name": "Drives", "path": NSNull()], ["name": target == "D:\\New project" ? "New project" : "Engineering", "path": target]],
                "folders": children, "truncated": false]
            return try JSONDecoder().decode(FolderResult.self, from: JSONSerialization.data(withJSONObject: json))
        }
        #endif
        guard canBrowseFolders(hostID), let connection = connections[hostID], let epoch = generations[hostID] else {
            throw ClientError.rejected(String(localized: "Folder browsing is unavailable. Reconnect or update Sotto on this computer."))
        }
        let result = try await connection.call(NewThreads.folderRequest(path: path), as: FolderResult.self)
        guard generations[hostID] == epoch, online(hostID) else { throw ClientError.disconnected }
        return result
    }
    /// Registration and creation are separate commands. Neither is replayed after a lost acknowledgement.
    func createThread(on hostID: String, projectID: String?, folder: FolderListing?, modelID: String,
                      effort: String, permissionID: String, workingCopy: WorkingCopy = .shared) async -> ThreadRef? {
        #if DEBUG && os(iOS)
        if isUIFixture {
            guard online(hostID), var root = fixtureShells[hostID], var host = root["host"] as? [String: Any],
                  let chosen = creationModels(hostID).first(where: { $0.id == modelID }) else { return nil }
            let threadID = UUID().uuidString, chosenProject = projectID ?? "new-project"
            do {
                _ = try Commands.createThread(projectID: chosenProject, threadID: threadID, model: chosen,
                                              effort: effort, permissionID: permissionID, mayAnswer: mayAnswer(hostID),
                                              workingCopy: workingCopy)
                // Only this debug simulator fixture can mutate in-memory display data without a host.
                var rows = host["threads"] as? [[String: Any]] ?? []
                rows.append(["id": threadID, "projectId": chosenProject, "title": "New thread", "providerId": "codex", "status": "idle", "requests": []])
                var projects = host["projects"] as? [[String: Any]] ?? []
                if let folder { projects.append(["id": chosenProject, "title": folder.projectName, "path": folder.path ?? ""]) }
                host["threads"] = rows; host["projects"] = projects; root["host"] = host
                let next = try JSONDecoder().decode(Shell.self, from: JSONSerialization.data(withJSONObject: root))
                fixtureShells[hostID] = root
                update(hostID) { $0.shell = next }
                fixtureDetails[hostID + "/" + threadID] = try JSONDecoder().decode(ThreadDetail.self, from: JSONSerialization.data(withJSONObject: ["threadId": threadID, "revision": 1, "messages": []]))
                return ThreadRef(hostID: hostID, threadID: threadID)
            } catch { creationFeedback = error.localizedDescription; return nil }
        }
        #endif
        guard creatingHostID == nil, storageReady, online(hostID),
              !pendingCreations.contains(where: { $0.hostID == hostID }), let computer = computer(hostID),
              let epoch = generations[hostID] else { return nil }
        creatingHostID = hostID; creationFeedback = nil
        defer { creatingHostID = nil }
        let threadID = UUID().uuidString
        do {
            guard (projectID != nil) != (folder != nil),
                  let model = creationModels(hostID).first(where: { $0.id == modelID }) else {
                throw ClientError.rejected(String(localized: "The project or model changed. Choose it again before opening a thread."))
            }
            // Validate the visible options before registering anything on the computer.
            _ = try Commands.createThread(projectID: projectID ?? "new-project", threadID: threadID, model: model,
                                          effort: effort, permissionID: permissionID, mayAnswer: mayAnswer(hostID),
                                          workingCopy: workingCopy)
            var chosenProject = projectID
            if let folder, let path = folder.path {
                guard case .listed(let fresh) = try await folders(hostID, path: .string(path)), fresh.path != nil else {
                    throw ClientError.rejected(String(localized: "This folder can no longer be opened. Nothing was added. Choose another folder."))
                }
                guard generations[hostID] == epoch, online(hostID) else { throw ClientError.disconnected }
                let confirmedPath = fresh.path!
                chosenProject = live[hostID]?.shell?.host.projects.first { NewThreads.sameFolder($0.path, confirmedPath, separator: fresh.separator) }?.id
                if chosenProject == nil {
                    guard let providerID = model.providerId,
                          live[hostID]?.shell?.host.providers?.first(where: { $0.id == providerID })?.capabilities.projects == true else {
                        throw ClientError.rejected(String(localized: "This provider cannot add a project folder. Choose another model."))
                    }
                    let command = try Commands.createProject(providerID: providerID, title: fresh.projectName, path: confirmedPath)
                    let marker = PendingOperation(hostID: hostID, clientID: computer.pairing.clientId, threadID: threadID, kind: "create-project")
                    try remember(marker)
                    guard let result = await dispatch(command, operation: marker), generations[hostID] == epoch,
                          !pending.contains(where: { $0.id == marker.id }) else {
                        creationFeedback = creationResultWords(hostID, project: true)
                        return nil
                    }
                    chosenProject = result.host.projects.first { NewThreads.sameFolder($0.path, confirmedPath, separator: fresh.separator) && ($0.providerId == nil || $0.providerId == providerID) }?.id
                }
            }
            guard generations[hostID] == epoch, online(hostID), let chosenProject,
                  live[hostID]?.shell?.host.projects.contains(where: { $0.id == chosenProject }) == true,
                  let currentModel = creationModels(hostID).first(where: { $0.id == modelID }) else {
                throw ClientError.rejected(String(localized: "The project or model is no longer available. Reconnect and choose it again."))
            }
            let command = try Commands.createThread(projectID: chosenProject, threadID: threadID, model: currentModel,
                                                   effort: effort, permissionID: permissionID, mayAnswer: mayAnswer(hostID),
                                                   workingCopy: workingCopy)
            let marker = PendingOperation(hostID: hostID, clientID: computer.pairing.clientId, threadID: threadID, kind: "create-thread")
            try remember(marker)
            _ = await dispatch(command, operation: marker)
            let ref = ThreadRef(hostID: hostID, threadID: threadID)
            guard generations[hostID] == epoch, online(hostID), thread(ref) != nil,
                  !pending.contains(where: { $0.id == marker.id }) else {
                creationFeedback = creationResultWords(hostID, project: false)
                return nil
            }
            return ref
        } catch { creationFeedback = error.localizedDescription; return nil }
    }
    /// What became of a project's registration (`project`) or a thread's creation that didn't finish.
    private func creationResultWords(_ hostID: String, project: Bool) -> String {
        let explanation = creationFeedback.map { $0 + " " } ?? ""
        if pendingCreations.contains(where: { $0.hostID == hostID }) {
            let unconfirmed = project
                ? String(localized: "Project registration on \(name(hostID)) is unconfirmed. Nothing was resent. Close this sheet and check Threads before trying again.", comment: "%@ is the computer's name. Threads is the name of a tab")
                : String(localized: "Thread creation on \(name(hostID)) is unconfirmed. Nothing was resent. Close this sheet and check Threads before trying again.", comment: "%@ is the computer's name. Threads is the name of a tab")
            return explanation + unconfirmed
        }
        let unfinished = project
            ? String(localized: "Project registration did not finish. Choose the project and model again.")
            : String(localized: "Thread creation did not finish. Choose the project and model again.")
        return creationFeedback ?? feedback ?? unfinished
    }

    // MARK: Alerts on this iPhone

    /// Whether iOS lets Sotto alert, asking the first time (ADR-0051). Settings calls this as a switch turns on.
    func allowAlerts() async -> Bool {
        #if DEBUG && os(iOS)
        // The simulator journeys never meet iOS's question, and nothing is posted from the fixture.
        if isUIFixture { return true }
        #endif
        guard let alerts else { return false }
        switch await alerts.permission() {
        case .allowed: return true
        case .denied: return false
        case .undecided: return await alerts.requestPermission()
        }
    }
    /// Whether iOS lets Sotto alert, without asking.
    func alertPermission() async -> AlertPermission {
        #if DEBUG && os(iOS)
        if isUIFixture { return .allowed }
        #endif
        guard let alerts else { return .undecided }
        return await alerts.permission()
    }
    /// A tapped alert opens its thread, on a computer this iPhone still holds. Watcher's own alert opens the Watcher tab.
    func openFromAlert(_ ref: ThreadRef, watcher: Bool = false) {
        guard computer(ref.hostID) != nil else { return }
        // Watcher's alert opens the Watcher tab on the computer it came from.
        if watcher { chooseWatcher(ref.hostID); watcherAlertOpened = ref.hostID } else { alertOpened = ref }
    }
    /// Alerts for what is new in a computer's thread list: never for the first list after connecting, the thread
    /// on screen, a switch that is off, or the UI fixture. Nothing about a thread but its title reaches an alert.
    private func noticeChanges(_ shell: Shell, from hostID: String) {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        var watch = watches[hostID] ?? ThreadWatch()
        let switches = AlertSwitches(needsYou: preferences.notifyNeedsYou, finished: preferences.notifyFinished,
                                     failed: preferences.notifyFailed)
        let news = watch.observe(shell.host.threads, hostID: hostID, computer: name(hostID), onScreen: threadOnScreen, switches: switches)
        watches[hostID] = watch
        guard let alerts, !news.isEmpty else { return }
        let sound = preferences.notifySound
        for alert in news { alerts.post(alert, sound: sound) }
    }

    // MARK: Updates from a computer

    private func applyShell(_ next: Shell, from hostID: String, sequence: Int, reconcileAnswers: Bool = true) throws {
        guard computer(hostID) != nil else { throw ClientError.invalidIdentity }
        try next.validate(hostID: hostID)
        guard sequence > (shellSequences[hostID] ?? 0) else { return }
        shellSequences[hostID] = sequence
        // Watcher's page is taken from `next` below, into its own store. The shell kept here leaves it out, so Watcher's
        // conversation growing doesn't change the computer's state, which nearly every view watches.
        var kept = next
        kept.watcher = nil
        update(hostID) {
            $0.shell = kept
            if let allowed = next.clientCapabilities?.mayAnswer { $0.mayAnswer = allowed }
        }
        noticeChanges(next, from: hostID)
        // Live evidence can arrive after the acknowledgement timed out. Never resend to settle it.
        // A Keychain write failure is local feedback, not a lost connection to the computer.
        for item in scoped(hostID) {
            // A connect, dispatch or solicited shell is followed by a receipt check. Keep its
            // answer markers through intervening pushes until their own receipts are read.
            if ["answer", "watcher-answer"].contains(item.kind), !reconcileAnswers || connecting.contains(hostID) || dispatchingOperations.keys.contains(item.id) || (deliveryChecks[hostID] ?? 0) > 0 { continue }
            do { try settle(item, shell: next) }
            catch { feedback = error.localizedDescription }
        }
        // Watcher's page comes with each shell from a computer that runs Watcher.
        if let page = next.watcher { applyWatcher(page, from: hostID) }
        if let selected, selected.hostID == hostID, !next.host.threads.contains(where: { $0.id == selected.threadID }) {
            cancelDetailReload(); self.selected = nil; openDetail = nil; detailStore.held = nil; detailProblem = nil
        }
    }
    private func push(_ frame: IncomingFrame, from hostID: String, sequence: Int) {
        do {
            switch frame {
            case .shell(let shell): try applyShell(shell, from: hostID, sequence: sequence)
            case .detail(let id, let detail):
                if let epoch = generations[hostID] { try applyDetail(detail, ref: ThreadRef(hostID: hostID, threadID: id), epoch: epoch) }
            case .delta(let id, let delta):
                guard delta.threadId == id else { throw ClientError.invalidIdentity }
                let ref = ThreadRef(hostID: hostID, threadID: id)
                guard selected == ref else { return }
                if let openDetail, delta.revision <= openDetail.revision { return }
                if let next = openDetail?.applying(delta), let epoch = generations[hostID] {
                    try applyDetail(next, ref: ref, epoch: epoch)
                } else { detailWantedRevision = max(detailWantedRevision, delta.revision); reloadDetail(ref) }
            case .failure(let failure):
                // The host sends this in place of an update too large for one frame; the connection stays open.
                feedback = failure.message
            default: throw ClientError.invalidProtocol
            }
        } catch {
            let words = String(localized: "The update from \(name(hostID)) could not be read. Reconnect to refresh it.", comment: "%@ is the computer's name")
            connectionEnded(hostID, problem: words, retrying: false)
            watches[hostID] = nil; watcherWatches[hostID] = nil
            connections[hostID]?.disconnect(); feedback = words
        }
    }
}

// MARK: - A thread's pull request (ADR-0102)

extension AppModel {
    static let pullRequestViewFeature = "pull-request-view"
    static let babysitFeature = "pull-request-babysit"
    /// Whether this computer offers the pull request sheet: one whose Owl answer turns it on lists `pull-request-view`.
    /// Without it the chip stays as it was, with no dot and no sheet.
    func offersPullRequestSheet(_ hostID: String) -> Bool { live[hostID]?.features.contains(Self.pullRequestViewFeature) == true }
    /// Whether the sheet offers Babysit pull request and Stop babysitting on this computer (ADR-0061).
    func offersBabysitting(_ hostID: String) -> Bool {
        offersPullRequestSheet(hostID) && live[hostID]?.features.contains(Self.babysitFeature) == true
    }
    private static func pullRequestReadKey(_ hostID: String, _ url: String) -> String? { PullRequests.key(url).map { hostID + "/" + $0 } }
    /// The pull request as this iPhone last read it, or nil before its sheet has opened since the app started.
    func lastPullRequest(_ ref: ThreadRef, url: String) -> PullRequestDetail? {
        Self.pullRequestReadKey(ref.hostID, url).flatMap { pullRequestReads[$0] }
    }
    /// Reads the pull request from GitHub through the thread's computer: when its sheet opens, and when it is refreshed.
    /// GitHub is never read ahead of time.
    func readPullRequest(_ ref: ThreadRef, url: String) async throws -> PullRequestRead {
        #if DEBUG && os(iOS)
        if isUIFixture {
            try? await Task.sleep(nanoseconds: 300_000_000)
            let detail = try JSONDecoder().decode(PullRequestDetail.self, from: JSONSerialization.data(withJSONObject: Self.fixturePullRequest(url: url)))
            keepPullRequest(detail, on: ref.hostID)
            return .detail(detail)
        }
        #endif
        guard offersPullRequestSheet(ref.hostID), online(ref.hostID), let connection = connections[ref.hostID], let epoch = generations[ref.hostID] else {
            throw ClientError.rejected(String(localized: "\(name(ref.hostID)) can’t be reached, so the pull request wasn’t read. Reconnect and try again.", comment: "%@ is the computer's name"))
        }
        let read = try await connection.call(try PullRequests.request(threadID: ref.threadID, url: url), as: PullRequestRead.self)
        guard generations[ref.hostID] == epoch else { throw ClientError.disconnected }
        if case .detail(let detail) = read { keepPullRequest(detail, on: ref.hostID) }
        return read
    }
    private func keepPullRequest(_ detail: PullRequestDetail, on hostID: String) {
        guard let key = Self.pullRequestReadKey(hostID, detail.url), pullRequestReads[key] != detail else { return }
        pullRequestReads[key] = detail
    }
    /// The pull requests the thread babysits and why babysitting each last ended, as its computer says.
    func babysitting(_ ref: ThreadRef) -> (current: [ThreadBabysitting], ended: [ThreadBabysitEnded]) {
        let summary = self.thread(ref)
        return (summary?.babysitting?.items ?? [], summary?.babysitEnded?.items ?? [])
    }
    /// A babysitting press on the thread still on its way to its computer, or not yet confirmed.
    func babysitPress(_ ref: ThreadRef) -> PendingOperation? {
        pending(for: ref).first { $0.kind == "babysit" || $0.kind == "stop-babysitting" }
    }
    func canChangeBabysitting(_ ref: ThreadRef) -> Bool { offersBabysitting(ref.hostID) && canAct(on: ref) }
    /// The user's own Babysit pull request or Stop babysitting (ADR-0061). It grants nothing, and like any thread command
    /// it is marked before it goes and never sent twice.
    func setBabysitting(_ on: Bool, url: String, in ref: ThreadRef) async {
        guard canChangeBabysitting(ref) else { return }
        #if DEBUG && os(iOS)
        if isUIFixture { babysitFixture(on, url: url, in: ref); return }
        #endif
        await act(on: ref, kind: on ? "babysit" : "stop-babysitting") { try Commands.babysit(threadID: ref.threadID, url: url, on: on) }
    }

    #if DEBUG && os(iOS)
    /// The working thread's draft pull request in the pull request journey, as a host on the Owl track reads it.
    private static func fixturePullRequest(url: String) -> [String: Any] {
        let stamp = ISO8601DateFormatter()
        // Every time is counted back from one moment, so a check's length comes out whole however the seconds fall.
        let now = Date()
        func at(_ secondsAgo: Double) -> String { stamp.string(from: now.addingTimeInterval(-secondsAgo)) }
        func check(_ name: String, _ status: String, started: Double, took: Double?) -> [String: Any] {
            ["name": name, "status": status, "url": "https://github.com/millZach/Sotto/actions/runs/1", "description": NSNull(),
             "startedAt": at(started), "completedAt": took.map { at(started - $0) as Any } ?? NSNull()]
        }
        return ["number": 721, "url": url, "title": "Let the window frost and put a terminal in the bottom third",
                "body": "## What this does\nFrosts the window and puts a **terminal** in the bottom third.\n\n- Tooltips read the theme\n- The drawer opens with `Ctrl+J`",
                "state": "open", "draft": true, "baseBranch": "main", "headBranch": "feat/frosted-window-and-pane-terminal", "crossRepository": false,
                "reviewDecision": "changes_requested", "mergeable": "mergeable", "checksUnknown": false, "mergedAt": NSNull(), "behindBy": 3,
                "reviews": [["author": "ollie-dev", "state": "approved", "url": NSNull()], ["author": "chloe-r", "state": "changes_requested", "url": NSNull()]],
                "checks": [check("Gates (Windows)", "failure", started: 30 * 60, took: 14 * 60 + 2), check("Package (macOS)", "pending", started: 6 * 60 + 10, took: nil),
                           check("Lint", "success", started: 30 * 60, took: 112), check("Typecheck", "success", started: 30 * 60, took: 67)],
                "files": [["path": "src/renderer/src/agents/TerminalDrawer.tsx", "additions": 120, "deletions": 30],
                          ["path": "src/renderer/src/agents/terminalTooltips.ts", "additions": 40, "deletions": 12], ["path": "CONTEXT.md", "additions": 2, "deletions": 0]],
                "changedFiles": 3, "mergeMethods": ["squash"], "autoMergeAllowed": false, "autoMerge": NSNull(), "canUpdateBranch": true, "linked": NSNull(), "branch": true]
    }
    /// Babysitting starts or stops on the fixture's computer, which sends the thread back with it.
    private func babysitFixture(_ on: Bool, url: String, in ref: ThreadRef) {
        guard var object = fixtureShells[ref.hostID], var host = object["host"] as? [String: Any], var threads = host["threads"] as? [[String: Any]],
              let index = threads.firstIndex(where: { $0["id"] as? String == ref.threadID }), let number = PullRequests.address(url)?.number else { return }
        if on {
            threads[index]["babysitting"] = [["url": url, "number": number, "startedBy": "user", "startedAt": ISO8601DateFormatter().string(from: Date())]]
        } else {
            threads[index].removeValue(forKey: "babysitting")
        }
        host["threads"] = threads; object["host"] = host; fixtureShells[ref.hostID] = object
        guard let shell = try? JSONDecoder().decode(Shell.self, from: JSONSerialization.data(withJSONObject: object)) else { return }
        update(ref.hostID) { $0.shell = shell }
    }
    #endif
}

// The Agents view (ADR-0103, an Owl feature): a thread's top bar counts its delegated threads and its provider's own
// sub-agents, and opens a sheet that lists them. Only a computer that lists `agents-view` offers it; a stable one
// doesn't, and nothing of it shows. Every read is the sheet opening or the user's own press; nothing here answers or
// changes anything on the computer.
extension AppModel {
    /// Whether this thread's computer offers the Agents view to this iPhone.
    func offersAgentsView(_ hostID: String) -> Bool { live[hostID]?.features.contains(AgentsRoster.feature) == true }
    /// What the thread's top bar says of its delegated threads and agents, from the thread list alone; nil when there is
    /// no Agents control. Worked out once until a computer's list changes: the top bar asks on every redraw.
    func agentsCount(_ ref: ThreadRef) -> AgentsCount? {
        if let kept = listed.agents[ref] { return kept }
        let count = countAgents(ref)
        listed.agents[ref] = .some(count)
        return count
    }
    private func countAgents(_ ref: ThreadRef) -> AgentsCount? {
        guard offersAgentsView(ref.hostID), let threads = live[ref.hostID]?.shell?.host.threads,
              let owner = threads.first(where: { $0.id == ref.threadID }) else { return nil }
        return AgentsRoster.count(owner, in: threads, failuresSeen: offersFailuresSeen(ref.hostID))
    }
    /// Whether the thread's computer says which failures a client has shown (`failure-seen`), so an unseen one can say
    /// Needs attention.
    func offersFailuresSeen(_ hostID: String) -> Bool { live[hostID]?.features.contains("failure-seen") == true }
    /// The thread, its computer's threads and its model catalog as the computer last shared them, for the sheet's rows.
    func agentsSource(_ ref: ThreadRef) -> AgentsSource? {
        guard offersAgentsView(ref.hostID), let host = live[ref.hostID]?.shell?.host,
              let owner = host.threads.first(where: { $0.id == ref.threadID }) else { return nil }
        return AgentsSource(owner: owner, threads: host.threads, models: host.models ?? [], failuresSeen: offersFailuresSeen(ref.hostID))
    }
    /// What delegation's record on the thread's computer says of its delegated threads. A thread with none isn't asked.
    func readDelegations(_ ref: ThreadRef) async throws -> ThreadDelegations {
        guard let source = agentsSource(ref), !AgentsRoster.delegated(below: ref.threadID, in: source.threads).isEmpty else {
            return ThreadDelegations(threadId: ref.threadID, threads: [])
        }
        #if DEBUG && os(iOS)
        if isUIFixture { return try Self.fixtureAgentsRead(ThreadDelegations.self, Self.fixtureDelegations(ref.threadID)) }
        #endif
        return try await agentsRead(ref, ["op": .string("thread-delegations"), "threadId": .string(ref.threadID)], as: ThreadDelegations.self)
    }
    /// Whether the thread's computer answers the sub-agent reads (`subagents`).
    func offersSubagents(_ hostID: String) -> Bool { live[hostID]?.features.contains("subagents") == true }
    /// The newest page of the thread's sub-agents. A thread whose provider reports none, or whose computer doesn't read
    /// them, isn't asked.
    func readSubagents(_ ref: ThreadRef) async throws -> SubagentPage {
        guard offersSubagents(ref.hostID), let source = agentsSource(ref), (source.owner.subagentSummary?.total ?? 0) > 0 else {
            return SubagentPage(threadId: ref.threadID, rows: [], summary: SubagentSummary())
        }
        #if DEBUG && os(iOS)
        if isUIFixture { return try Self.fixtureAgentsRead(SubagentPage.self, Self.fixtureSubagents(ref.threadID)) }
        #endif
        return try await agentsRead(ref, ["op": .string("subagent-page"), "request": .object(["threadId": .string(ref.threadID)])], as: SubagentPage.self)
    }
    /// One sub-agent's runs, newest first, for its row's task and result.
    func readAssignments(_ ref: ThreadRef, agentID: String) async throws -> SubagentAssignmentsPage {
        #if DEBUG && os(iOS)
        if isUIFixture { return try Self.fixtureAgentsRead(SubagentAssignmentsPage.self, Self.fixtureAssignments(ref.threadID, agentID: agentID)) }
        #endif
        guard offersSubagents(ref.hostID) else { throw ClientError.invalidRequest }
        return try await agentsRead(ref, ["op": .string("subagent-assignments"),
            "request": .object(["threadId": .string(ref.threadID), "agentId": .string(agentID)])], as: SubagentAssignmentsPage.self)
    }
    private func agentsRead<T: Decodable & Sendable>(_ ref: ThreadRef, _ operation: [String: JSONValue], as type: T.Type) async throws -> T {
        guard offersAgentsView(ref.hostID), online(ref.hostID), let connection = connections[ref.hostID], let epoch = generations[ref.hostID] else {
            throw ClientError.rejected(String(localized: "Can\u{2019}t reach \(name(ref.hostID)) to read its agents. Nothing was changed. Reconnect, then try again.", comment: "%@ is the computer's name"))
        }
        let result = try await connection.call(operation, as: type)
        guard generations[ref.hostID] == epoch, online(ref.hostID) else { throw ClientError.disconnected }
        return result
    }

    #if DEBUG && os(iOS)
    /// The Agents journey (`--ui-agents`): the working thread delegated a review, which waits on the user's approval, and
    /// a look at the drawer's docs, which has answered; its provider runs two agents of its own.
    fileprivate func addFixtureAgents(to threads: inout [String: [[String: Any]]], laptop: String, at: (Double) -> String) {
        guard var rows = threads[laptop], let index = rows.firstIndex(where: { $0["id"] as? String == "iphone" }) else { return }
        rows[index]["subagentSummary"] = ["total": 2, "working": 1, "completed": 1, "failed": 0, "interrupted": 0, "unknown": 0]
        rows.append(["id": "review-fix", "hostId": laptop, "projectId": "sotto", "title": "Review the drawer fix", "providerId": "claude",
            "status": "running", "delegatedBy": "iphone", "summary": ["lastMessageAt": at(60), "runningTurnStartedAt": at(4 * 60)],
            "requests": [["id": "review-permission", "kind": "permission", "text": "Run npm test -- terminalDrawer?", "options": []]]])
        rows.append(["id": "drawer-docs", "hostId": laptop, "projectId": "sotto", "title": "Check the drawer docs", "providerId": "codex",
            "status": "idle", "delegatedBy": "iphone", "requests": [], "summary": ["lastMessageAt": at(9 * 60)]])
        threads[laptop] = rows
        let replies = ["review-fix": "The wait on the chord is sound. I would like to run the drawer tests to be sure.",
                       "drawer-docs": "The docs promise the drawer opens within 300 ms."]
        for (id, brief) in [("review-fix", Self.fixtureReviewBrief), ("drawer-docs", Self.fixtureDocsBrief)] {
            let detail: [String: Any] = ["threadId": id, "revision": 1, "messages": [["id": "brief", "role": "user", "text": brief, "createdAt": at(12 * 60)],
                ["id": "reply", "role": "assistant", "text": replies[id] ?? "", "createdAt": at(9 * 60)]]]
            fixtureDetails[laptop + "/" + id] = try! Self.fixtureAgentsRead(ThreadDetail.self, detail)
        }
    }
    private static let fixtureReviewBrief = "Review the change to TerminalDrawer.tsx on feat/frosted-window. Say whether the chord can still fire twice, and run its tests."
    private static let fixtureDocsBrief = "Read docs/terminal.md and say what it promises about how long the drawer may take to open."
    private static func fixtureStamp(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60)) }
    private static func fixtureDelegations(_ threadID: String) -> [String: Any] {
        ["threadId": threadID, "threads": [
            ["thread": "review-fix", "by": threadID, "work": "code-review", "outcome": "working", "startedAt": fixtureStamp(4), "waiting": false, "brief": fixtureReviewBrief],
            ["thread": "drawer-docs", "by": threadID, "work": "research", "outcome": "answered", "startedAt": fixtureStamp(12), "outcomeAt": fixtureStamp(9),
             "waiting": false, "brief": fixtureDocsBrief]]]
    }
    private static func fixtureSubagents(_ threadID: String) -> [String: Any] {
        let summary: [String: Any] = ["total": 2, "working": 1, "completed": 1, "failed": 0, "interrupted": 0, "unknown": 0]
        let suite: [String: Any] = ["id": "suite", "sequence": 2, "revision": 1, "assignmentId": "suite-1", "assignmentCount": 1,
            "title": "Run the drawer tests twenty times", "description": "Run the drawer tests twenty times", "model": "gpt-6.1-sol",
            "status": "running", "startedAt": fixtureStamp(1), "lastObservedAt": fixtureStamp(0)]
        let waits: [String: Any] = ["id": "waits", "sequence": 1, "revision": 1, "assignmentId": "waits-1", "assignmentCount": 1,
            "title": "Find fixed waits in the drawer tests", "description": "Find fixed waits in the drawer tests", "model": "gpt-6.1-sol",
            "status": "completed", "startedAt": fixtureStamp(14), "completedAt": fixtureStamp(13), "lastObservedAt": fixtureStamp(13), "durationMs": 48_000]
        return ["threadId": threadID, "revision": 2, "summary": summary, "rows": [suite, waits]]
    }
    private static func fixtureAssignments(_ threadID: String, agentID: String) -> [String: Any] {
        let running = agentID == "suite"
        let assignment: [String: Any] = ["id": agentID + "-1", "sequence": 1, "status": running ? "running" : "completed",
            "title": running ? "Run the drawer tests twenty times" : "Find fixed waits in the drawer tests",
            "prompt": running ? "Run the drawer tests twenty times and count the failures." : "Find every setTimeout and fixed wait under tests/unit/renderer.",
            "result": running ? "Run 11 of 20. No failures so far." : "Three fixed waits. Only terminalDrawer.test.ts waits on the chord."]
        return ["threadId": threadID, "agentId": agentID, "assignments": [assignment]]
    }
    private static func fixtureAgentsRead<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }
    #endif
}

/// A thread with its computer's threads and model catalog, as the Agents sheet reads them.
struct AgentsSource {
    let owner: ThreadSummary
    let threads: [ThreadSummary]
    let models: [ThreadModel]
    /// Whether the computer says which failures a client has shown (`failure-seen`).
    let failuresSeen: Bool
}
