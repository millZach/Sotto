import Foundation
import Combine
import SottoCore

/// The iPhone's side of the to-do list (ADR-0188). It outlives whatever shows it, because the five seconds a check-off waits go
/// on through rolling up and moving to another page: nothing reaches the computer that holds the item until they end, and an
/// app that goes away in those seconds leaves the item unchecked, which loses nothing.
@MainActor final class ToDoStore: ObservableObject {
    @Published private(set) var book = ToDoBook()
    @Published private(set) var open = false
    /// The last press failed. Rolling up reads it.
    @Published private(set) var failed = false
    /// What is being written in Add your own. Kept here, so words a computer refused come back after a roll up.
    @Published var draft = ""
    /// What was new when the list opened, or came while it stood open: marked until it rolls up, though the badge is quiet.
    @Published private(set) var marked: Set<String> = []
    /// Carries a press to the computer that holds the item. Set once, by the model.
    var send: ((ToDoRequest, String) async throws -> Void)?
    var undoNanoseconds = ToDoWire.undoSeconds * 1_000_000_000
    private var holds: [String: Task<Void, Never>] = [:]
    private var askedSeen: Set<String> = []

    func take(hostID: String, items: [ToDoItem]) {
        for key in book.take(hostID: hostID, items: items) { holds.removeValue(forKey: key)?.cancel() }
        if open { noteSeen() }
    }
    func forget(hostID: String) {
        for key in book.forget(hostID: hostID) { holds.removeValue(forKey: key)?.cancel() }
    }
    func toggle() { if open { rollUp() } else { unroll() } }
    func unroll() { open = true; noteSeen() }
    func rollUp() { open = false; failed = false; marked = []; askedSeen = [] }
    /// The list's last row going rolls it up, once its press has an answer. A list opened empty stays, for adding to.
    func rowsChanged(from before: Int, to now: Int) { if open && before > 0 && now == 0 { rollUp() } }
    /// Opening quiets the badge on each computer, and so does anything that comes while it stands open.
    private func noteSeen() {
        let fresh = book.rows.filter { !$0.item.seen }
        marked.formUnion(fresh.map(\.id))
        for hostID in Set(fresh.filter { !askedSeen.contains($0.id) }.map(\.hostID)) {
            askedSeen.formUnion(fresh.filter { $0.hostID == hostID }.map(\.id))
            Task { try? await send?(.seen, hostID) }
        }
    }
    /// Takes it off in five seconds, unless Undo comes first.
    func check(_ row: ToDoRow) {
        guard holds[row.id] == nil else { return }
        failed = false
        book.hold(row.id)
        let wait = undoNanoseconds
        holds[row.id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: wait)
            guard !Task.isCancelled, let self else { return }
            self.book.sending(row.id)
            do { try await self.send?(.check(id: row.item.id, didNotWork: nil), row.hostID) } catch {
                guard !Task.isCancelled else { return }
                self.book.release(row.id)
                self.holds[row.id] = nil
                self.fail()
            }
        }
    }
    func undo(_ row: ToDoRow) {
        guard !row.sending else { return }
        holds.removeValue(forKey: row.id)?.cancel()
        book.release(row.id)
    }
    /// It did not work: the user's words go at once, since they asked to send them. False leaves the words to send again.
    func didNotWork(_ row: ToDoRow, words: String) async -> Bool {
        failed = false
        do { try await send?(.check(id: row.item.id, didNotWork: words), row.hostID); return true } catch { fail(); return false }
    }
    /// The user's own goes to the first computer connected. A failure gives the words back to send again, unless they have
    /// moved on to writing others.
    func addDraft() async {
        let words = String(draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ToDoWire.titleMax))
        guard !words.isEmpty, let host = book.firstHost else { return }
        draft = ""
        failed = false
        do { try await send?(.add(title: words), host) } catch {
            fail()
            if draft.isEmpty { draft = words }
        }
    }
    /// A press that failed says so, even with the list rolled up by then.
    private func fail() { failed = true; if !open { unroll() } }
}

/// One of a prototype's pages, and where it opens on the computer that serves it.
struct PrototypePageLink: Identifiable {
    let page: RequestPage
    let url: URL
    var id: String { page.token }
}
