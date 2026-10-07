import Foundation
import SwiftUI
import SottoCore

/// A computer step 1 of adding found at a private address, with the health it answered.
struct FoundHost: Equatable {
    let endpoint: HostEndpoint; let health: Health
    /// The computer's own name, or its name on the tailnet from a host that sends none.
    var name: String { health.computerName ?? endpoint.machine }
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
}

/// Where a photo comes from: a name for it and its original bytes, read when its turn comes.
struct PhotoSource: Sendable {
    let name: String
    let load: @Sendable () async throws -> Data
}

/// A photo in a thread's reply box. It is prepared on this iPhone, then staged on the thread's computer,
/// and stays in memory until the reply is sent or the photo is removed. Nothing is written to disk.
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
}

/// Every paired computer, each with its own connection, session and state. A computer that can't be
/// reached, or fails, never holds up the others. Everything that names a thread names its computer too.
@MainActor final class AppModel: ObservableObject {
    private static let requestNoLongerWaiting = "That request is no longer waiting."
    private static let markersUnreadable = "Saved unconfirmed actions could not be read. Check your threads before sending again. Nothing was resent."
    private static func pairingWarning(_ count: Int) -> String {
        count == 1 ? "1 saved computer needs pairing again." : "\(count) saved computers need pairing again."
    }
    /// In the order they were added. Credentials live in the Keychain, one item per host ID.
    @Published private(set) var computers: [SavedComputer] = []
    @Published private(set) var live: [String: Live] = [:]
    @Published private(set) var selected: ThreadRef?
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
    /// Photos in each thread's reply box, by `ThreadRef.id`, in the order they were chosen.
    @Published private(set) var draftPhotos: [String: [DraftPhoto]] = [:]
    /// Why the last photo chosen for a reply box wasn't added, by `ThreadRef.id`.
    @Published var photoNotices: [String: String] = [:]
    /// The photos of a reply on its way, by operation ID, and of a refused reply, by `ThreadRef.id`.
    @Published private(set) var submittedPhotos: [String: [DraftPhoto]] = [:]
    @Published private(set) var failedPhotos: [String: [DraftPhoto]] = [:]
    /// Threads whose reply is having its photos staged again before it is sent. A second press finds it here.
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
    private static let sendingKinds: Set<String> = ["reply", "answer", "interrupt"]
    /// A receipt the computer says is still being carried out is read again this often, this many times: about ten minutes.
    private static let receiptInterval: UInt64 = 2_000_000_000
    private static let receiptReads = 300
    private var stagingTasks: [UUID: Task<Bool, Never>] = [:]
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
    /// This iPhone's own preferences: alert switches and new-thread defaults.
    var preferences = PhonePreferences()
    /// Posts local alerts. Nil until the app hands it over.
    var alerts: AlertPosting?
    /// What each computer's thread list held when this iPhone last read it, for alerts. Emptied when a connection
    /// ends, so the first list after connecting is never news.
    private var watches: [String: ThreadWatch] = [:]
    /// Whether the app is on screen now, rather than inactive or in the background.
    private var foreground = false
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
    private var fixtureDetails: [String: ThreadDetail] = [:]
    private var fixtureShells: [String: [String: Any]] = [:]
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
        // The question journey: the working thread asks a question, and the laptop lets this iPhone answer it.
        let asking = arguments.contains("--ui-question-while-reading")
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
        for (host, name) in [(laptop, "Laptop"), (studio, "Studio Mac")] {
            let answers = asking && host == laptop
            let hostCaps = answers ? answeringCaps : caps
            let pairing = decode(Pairing.self, ["v": 1, "hostId": host, "clientId": "ui-fixture", "token": "not-a-credential"])
            computers.append(SavedComputer(address: "https://fixture.invalid.ts.net", pairing: pairing, reportedName: name))
            let shellObject: [String: Any] = ["hostId": host, "host": ["hostId": host, "name": name,
                "threads": threads[host] ?? [], "projects": [["id": "sotto", "title": "Sotto", "path": "D:\\Talk to Text Application"],
                    ["id": "panel", "title": "Panel tools", "path": "D:\\Engineering\\Panel tools"], ["id": "house", "title": "House", "path": "D:\\House"]],
                "models": [["id": "fixture-model", "name": "GPT-6.1 Sol", "provider": "Codex", "providerId": "codex", "ready": true,
                    "reasoningEfforts": ["low", "medium", "high"], "defaultReasoningEffort": "high", "runtimeModes": ["approval-required", "full-access"]]],
                "providers": [["id": "codex", "connection": "connected", "capabilities": hostCaps]], "capabilities": hostCaps]]
            fixtureShells[host] = shellObject
            let shell = decode(Shell.self, shellObject)
            live[host] = Live(status: host == laptop ? .online : .unreachable, shell: shell, mayAnswer: answers, features: ["host-folders"])
        }
        storageReady = true
        if arguments.contains("--ui-streaming") { streamFixture(host: laptop) }
        if arguments.contains("--ui-feedback-request-gone") { feedback = Self.requestNoLongerWaiting }
        if arguments.contains("--ui-feedback-markers-unreadable") { feedback = Self.markersUnreadable }
        if arguments.contains("--ui-feedback-computer-unreadable") { feedback = "Recovered the saved computer list. " + Self.pairingWarning(1) }
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
    /// key chords that end in a backtick, and a fenced code block.
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
        feedback = "Answer sent."
    }
    #endif

    // MARK: Reading

    func computer(_ hostID: String) -> SavedComputer? { computers.first { $0.hostID == hostID } }
    func name(_ hostID: String) -> String { computer(hostID)?.name ?? "the computer" }
    func status(_ hostID: String) -> ComputerStatus { live[hostID]?.status ?? .connecting }
    func online(_ hostID: String) -> Bool { status(hostID) == .online }
    func mayAnswer(_ hostID: String) -> Bool { live[hostID]?.mayAnswer ?? false }
    /// The thread the user is reading now: the open thread while the app is on screen.
    var threadOnScreen: ThreadRef? { foreground ? selected : nil }
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
    func answering(_ hostID: String) -> Bool { scoped(hostID).contains { $0.kind == "answer" } }
    private func canAct(on ref: ThreadRef) -> Bool { online(ref.hostID) && thread(ref) != nil && pending(for: ref).isEmpty }
    func canSend(_ ref: ThreadRef) -> Bool {
        guard canAct(on: ref), let thread = self.thread(ref), thread.status != "running", thread.requests.isEmpty else { return false }
        let source = provider(for: ref)
        return (capabilities(for: ref)?.submit ?? false) && (source == nil || source?.connection == "connected")
    }
    /// Whether the reply box holds something to send and nothing still being made ready: words or photos,
    /// every photo prepared, and none of them on a thread whose model can't take them.
    func canSendReply(_ ref: ThreadRef) -> Bool {
        let photos = self.photos(ref)
        let written = !(drafts[ref.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return canSend(ref) && !preparingSends.contains(ref.id) && (written || !photos.isEmpty)
            && !photos.contains(where: \.preparing) && (photos.isEmpty || photoSupport(ref) == .available)
    }
    func photos(_ ref: ThreadRef) -> [DraftPhoto] { draftPhotos[ref.id] ?? [] }
    func photoSupport(_ ref: ThreadRef) -> PhotoSupport {
        PhotoSupport(online: online(ref.hostID), thread: thread(ref), host: live[ref.hostID]?.shell?.host, features: live[ref.hostID]?.features ?? [])
    }
    /// A reply, answer or stop still on its way, as opposed to one its computer couldn't confirm.
    func isSending(_ item: PendingOperation) -> Bool { dispatchingOperations.keys.contains(item.id) || receiptFollowers[item.id] != nil }
    func canInterrupt(_ ref: ThreadRef) -> Bool {
        online(ref.hostID) && pending(for: ref).allSatisfy { $0.kind == "reply" }
            && thread(ref)?.status == "running" && (capabilities(for: ref)?.interrupt ?? false)
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
        let storageProblem = "Secure connection details could not be read. Unlock this iPhone and return to Sotto."
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
            pending = markers.filter { marker in kept.contains { marker.matches(hostID: $0.hostID, clientID: $0.pairing.clientId) } }
            computers = kept; computerIndexAccount = indexAccount
            for computer in kept { live[computer.hostID] = Live() }
            storageReady = true
            if unreadableComputers > 0 { warnings.append(Self.pairingWarning(unreadableComputers)) }
            if announceRecovery { warnings.insert(kept.isEmpty ? "The saved computer list could not be recovered." : "Recovered the saved computer list.", at: 0) }
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
            retries.values.forEach { $0.cancel() }; retries.removeAll(); retryAttempts.removeAll()
            active = false; pairGeneration = UUID(); working = false; openDetail = nil
            for (hostID, connection) in connections { generations[hostID] = UUID(); connection.disconnect() }
            connecting.removeAll(); watches.removeAll()
            live = live.mapValues { (state: Live) -> Live in var next = state; next.status = .connecting; next.mayAnswer = false; return next }
        }
    }
    /// Wait for the connection work scheduled by activation, including delivery checks.
    func waitForActivation() async { await activationConnection?.value }
    /// Wait until every photo chosen so far has been prepared and staged, or has left its reply box.
    func waitForPhotos() async {
        await photoWork?.value
        for task in Array(stagingTasks.values) { _ = await task.value }
    }
    func reconnectAll() async {
        let ids = computers.map(\.hostID)
        await withTaskGroup(of: Void.self) { group in
            for hostID in ids { group.addTask { await self.connect(hostID) } }
        }
    }
    /// Pull to refresh: reconnects every computer, but returns once the ones that were reachable are
    /// back, rather than waiting out one that can't be reached. With none reachable, it waits for all.
    func refresh() async {
        #if DEBUG && os(iOS)
        if isUIFixture { return }
        #endif
        let started = computers.map { computer in
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
        shellSequences[hostID] = 0; watches[hostID] = nil
        defer { if generations[hostID] == current { connecting.remove(hostID) } }
        update(hostID) { $0.status = .connecting; $0.mayAnswer = false; $0.problem = nil }
        if selected?.hostID == hostID { cancelDetailReload(); openDetail = nil; detailProblem = nil }
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
            if let selected, selected.hostID == hostID, thread(selected) == nil { self.selected = nil }
        } catch {
            guard generations[hostID] == current else { return }
            update(hostID) { $0.status = .unreachable; $0.mayAnswer = false; $0.problem = error.localizedDescription }
            connections[hostID]?.disconnect()
            if let error = error as? ClientError {
                switch error {
                case .invalidIdentity, .invalidProtocol, .invalidHost, .rejected: return
                default: break
                }
            }
            scheduleRetry(hostID)
            return
        }
        retries.removeValue(forKey: hostID)?.cancel()
        // A refused or slow thread read does not mean the computer's connection was lost.
        do { try await observeAndRead(hostID) }
        catch { if generations[hostID] == current { detailProblem = "This thread could not be loaded. Nothing was lost. Try again." } }
        await checkDelivery(hostID)
    }
    private func scheduleRetry(_ hostID: String) {
        guard active, computer(hostID) != nil, retries[hostID] == nil else { return }
        let attempt = retryAttempts[hostID] ?? 0
        retryAttempts[hostID] = min(attempt + 1, 5)
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
        made.onLiveness = { [weak self] in self?.retryAttempts[hostID] = nil }
        made.onPush = { [weak self] frame, sequence in self?.push(frame, from: hostID, sequence: sequence) }
        made.onDisconnect = { [weak self] in
            self?.generations[hostID] = UUID(); self?.connecting.remove(hostID); self?.watches[hostID] = nil
            if self?.selected?.hostID == hostID { self?.cancelDetailReload() }
            self?.update(hostID) { $0.status = .unreachable; $0.mayAnswer = false; $0.problem = ClientError.disconnected.localizedDescription }
            self?.scheduleRetry(hostID)
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
    /// on 8443, where the desktop serves it, then on 443.
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
                pairFeedback = "This iPhone is already paired with \(existing.name). To pair it again, remove it in Computers first."
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
        retries.removeValue(forKey: hostID)?.cancel(); retryAttempts[hostID] = nil
        generations[hostID] = UUID(); connecting.remove(hostID)
        connections[hostID]?.close(); connections[hostID] = nil
        let gone = Set(pending.filter { $0.hostID == hostID }.map(\.id))
        computers = rest; live[hostID] = nil; pending = markers; watches[hostID] = nil
        if selected?.hostID == hostID { cancelDetailReload(); selected = nil; openDetail = nil; detailProblem = nil }
        if show == .only(hostID) { show = .all }
        let prefix = hostID + "/"
        drafts = drafts.filter { !$0.key.hasPrefix(prefix) }
        failedReplies = failedReplies.filter { !$0.key.hasPrefix(prefix) }
        draftPhotos = draftPhotos.filter { !$0.key.hasPrefix(prefix) }
        failedPhotos = failedPhotos.filter { !$0.key.hasPrefix(prefix) }
        photoNotices = photoNotices.filter { !$0.key.hasPrefix(prefix) }
        submitted = submitted.filter { !gone.contains($0.key) }
        submittedPhotos = submittedPhotos.filter { !gone.contains($0.key) }
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
            let there = "Remove it there too: in Settings › Phones on \(name). For a computer without a screen, use Phones on its row in Settings › Hosts on your main computer, or its --revoke-client \(clientID) command."
            switch self {
            case .confirmed: return "Removed \(name)."
            case .unreachable: return "Removed \(name) from this iPhone. It couldn’t be reached, so it still lists this iPhone. " + there
            case .unconfirmed: return "Removed \(name) from this iPhone, but couldn’t confirm removal there, so it may still list this iPhone. " + there
            }
        }
    }

    // MARK: The open thread

    func select(_ ref: ThreadRef?) async {
        cancelDetailReload()
        let previous = selected
        selected = ref; openDetail = nil; detailProblem = nil; detailVersion += 1
        #if DEBUG && os(iOS)
        if isUIFixture {
            let detail = ref.flatMap { fixtureDetails[$0.id] }
            if fixtureSlowDetail, let ref {
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard selected == ref else { return }
            }
            openDetail = detail
            return
        }
        #endif
        if let previous, previous.hostID != ref?.hostID, online(previous.hostID), let before = connections[previous.hostID] {
            _ = try? await before.call(["op": .string("observe"), "threadIds": .array([])])
        }
        // Another thread may have been opened, or its computer reconnected, while the last one was let go.
        guard let ref, selected == ref, online(ref.hostID) else { return }
        let current = generations[ref.hostID]
        do { try await observeAndRead(ref.hostID) }
        catch { if generations[ref.hostID] == current, selected == ref { detailProblem = "This thread could not be loaded. Nothing was lost. Try again." } }
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
                    detailProblem = "This thread could not be refreshed. Nothing was lost. Try again."
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
        var images: [StagedImage] = []
        if !photos(ref).isEmpty {
            preparingSends.insert(ref.id)
            let ready = await readyPhotos(ref)
            preparingSends.remove(ref.id)
            guard let ready else { return }
            images = ready
        }
        // Nothing below waits until the marker is kept, so the checks hold when it is.
        guard canSend(ref), images.isEmpty || photoSupport(ref) == .available, let computer = self.computer(ref.hostID) else {
            if !images.isEmpty { photoNotices[ref.id] = "Your reply wasn’t sent. It’s still in the reply box." }
            return
        }
        let draft = UUID().uuidString
        do {
            let command = try Commands.prompt(threadID: ref.threadID, text: text, draftID: draft, images: images)
            let operation = PendingOperation(hostID: ref.hostID, clientID: computer.pairing.clientId, threadID: ref.threadID, draftID: draft, kind: "reply")
            try remember(operation); submitted[operation.id] = text; drafts[ref.id] = ""
            if !images.isEmpty { submittedPhotos[operation.id] = photos(ref); photosSent?(photos(ref), ref); draftPhotos[ref.id] = nil }
            photoNotices[ref.id] = nil
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }

    // MARK: Photos in the reply box

    /// Adds photos to a thread's reply box. Each is prepared off the main actor and staged on the thread's
    /// computer in the order chosen, one at a time, so several large photos are never held decoded at once.
    func attachPhotos(_ ref: ThreadRef, from sources: [PhotoSource]) {
        guard !sources.isEmpty, photoSupport(ref) == .available, !preparingSends.contains(ref.id) else { return }
        let room = PhotoLimits.count - photos(ref).count
        guard room > 0 else { photoNotices[ref.id] = "A reply can carry \(PhotoLimits.count) photos."; return }
        let added = sources.prefix(room).map { (photo: DraftPhoto(), source: $0) }
        draftPhotos[ref.id, default: []] += added.map { $0.photo }
        photoNotices[ref.id] = sources.count > room ? "A reply can carry \(PhotoLimits.count) photos. The others weren’t added." : nil
        let previous = photoWork
        photoWork = Task { [weak self] in
            await previous?.value
            for item in added { await self?.prepare(item.photo.id, in: ref, from: item.source) }
        }
    }
    func removePhoto(_ id: UUID, from ref: ThreadRef) {
        guard !preparingSends.contains(ref.id) else { return }
        dropPhoto(id, in: ref, reason: nil)
    }
    private func prepare(_ id: UUID, in ref: ThreadRef, from source: PhotoSource) async {
        // Removed while it waited its turn: nothing is read.
        guard photo(id, in: ref) != nil else { return }
        do {
            let prepared = try await preparePhoto(try await loaded(source, for: id), source.name)
            guard photo(id, in: ref) != nil else { return }
            let others = photos(ref).filter { $0.id != id }.compactMap { $0.prepared?.byteCount }
            guard Photos.fits(prepared.byteCount, with: others) else {
                throw ClientError.rejected("These photos would take the reply over 20 MB, so this one wasn’t added. Send these first, or remove one.")
            }
            change(id, in: ref) { $0.prepared = prepared }
            // Staged on its own, so a slow computer never holds up preparing photos for any other reply.
            _ = staging(id, in: ref)
        } catch {
            // A photo the library couldn't hand over reads as one that couldn't be read.
            let reason = (error as? PhotoPipelineError)?.errorDescription ?? (error as? ClientError)?.errorDescription
            dropPhoto(id, in: ref, reason: reason ?? PhotoPipelineError.unreadable.errorDescription!)
        }
    }
    /// A photo's original bytes, or `tooSlow` once the limit passes, so one that never arrives can't hold up the
    /// photos chosen after it, and removing the photo ends the wait at once. A load that ignores cancellation is
    /// left to finish on its own.
    private func loaded(_ source: PhotoSource, for id: UUID) async throws -> Data {
        let load = PhotoLoad()
        photoLoads[id] = load
        defer { photoLoads[id] = nil }
        let limit = photoLoadLimit
        return try await withCheckedThrowingContinuation { continuation in
            load.continuation = continuation
            load.tasks = [
                Task { do { load.finish(.success(try await source.load())) } catch { load.finish(.failure(error)) } },
                Task { do { try await limit(); load.finish(.failure(PhotoPipelineError.tooSlow)) } catch {} },
            ]
        }
    }
    /// A photo's staging, started now unless it is already under way: a photo is never staged twice at once.
    private func staging(_ id: UUID, in ref: ThreadRef) -> Task<Bool, Never>? {
        if let running = stagingTasks[id] { return running }
        guard let prepared = photo(id, in: ref)?.prepared else { return nil }
        change(id, in: ref) { $0.staging = true }
        let task = Task { [weak self] () -> Bool in
            let staged = await self?.requestStaging(prepared, as: id, in: ref) ?? false
            self?.stagingTasks[id] = nil
            self?.change(id, in: ref) { $0.staging = false }
            return staged
        }
        stagingTasks[id] = task
        return task
    }
    private func stage(_ id: UUID, in ref: ThreadRef) async -> Bool { await staging(id, in: ref)?.value ?? false }
    /// Stages one prepared photo on its thread's computer. A photo that couldn't reach it stays in the box and
    /// is staged when the reply is sent; one the computer refused for what it is leaves the box, with its reason.
    private func requestStaging(_ prepared: PreparedPhoto, as id: UUID, in ref: ThreadRef) async -> Bool {
        let over = generations[ref.hostID]
        do {
            let operation = try Photos.stage(name: prepared.name, mimeType: prepared.mimeType, base64: prepared.base64, dimensions: prepared.dimensions)
            let handle = try await largeRequest(on: ref.hostID) { connection -> StagedImage in
                let handle = try await connection.call(operation, as: StagedImage.self)
                guard handle.valid else { throw ClientError.invalidProtocol }
                return handle
            }
            change(id, in: ref) { $0.staged = handle; $0.stagedAt = Date(); $0.stagedGeneration = over }
            return true
        } catch let refusal as HostRefusal where refusal.failure.code == "invalid_request" {
            dropPhoto(id, in: ref, reason: refusal.failure.message)
        } catch {}
        return false
    }
    /// Every photo in the reply box with a handle its computer still keeps: staged now if it never got there,
    /// or again if it has been there long enough to be let go. Nil, with the reason, when one can't be.
    private func readyPhotos(_ ref: ThreadRef) async -> [StagedImage]? {
        // Only this reply's own photos are waited for: one still on its way is joined, not sent again.
        // Each photo is read as it is now, not as it was when the loop began: one staged meanwhile is not staged again.
        for id in photos(ref).map(\.id) {
            // One that left the box while the reply waited, refused by the computer, makes it a reply the user
            // didn't press: nothing is sent, and the box says why.
            guard let photo = photo(id, in: ref) else { return nil }
            guard stagingTasks[id] != nil || photo.needsStaging(generation: generations[ref.hostID]) else { continue }
            guard await stage(id, in: ref) else {
                if photoNotices[ref.id] == nil {
                    photoNotices[ref.id] = "A photo couldn’t reach \(name(ref.hostID)), so nothing was sent. Try again when it’s connected."
                }
                return nil
            }
        }
        let current = photos(ref)
        let staged = current.compactMap(\.staged)
        return !staged.isEmpty && staged.count == current.count ? staged : nil
    }
    private func photo(_ id: UUID, in ref: ThreadRef) -> DraftPhoto? { draftPhotos[ref.id]?.first { $0.id == id } }
    private func change(_ id: UUID, in ref: ThreadRef, _ edit: (inout DraftPhoto) -> Void) {
        guard let index = draftPhotos[ref.id]?.firstIndex(where: { $0.id == id }) else { return }
        edit(&draftPhotos[ref.id]![index])
    }
    /// Takes a photo out of its reply box, saying why when it wasn't the user's choice.
    private func dropPhoto(_ id: UUID, in ref: ThreadRef, reason: String?) {
        guard photo(id, in: ref) != nil else { return }
        photoLoads[id]?.finish(.failure(CancellationError()))
        draftPhotos[ref.id]?.removeAll { $0.id == id }
        if draftPhotos[ref.id]?.isEmpty == true { draftPhotos[ref.id] = nil }
        photoNotices[ref.id] = reason
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
    /// A sent photo's bytes from the computer that keeps it. It waits its turn behind other large requests to
    /// that computer, and is never made if nothing on screen still `wanted` it by then.
    func sentPhoto(_ ref: ThreadRef, messageID: String, attachmentID: String, wanted: @escaping @MainActor () -> Bool) async -> Data? {
        let operation = Photos.preview(threadID: ref.threadID, messageID: messageID, attachmentID: attachmentID)
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
    private func remember(_ operation: PendingOperation) throws {
        guard pending.count < 100 else { throw ClientError.rejected("Check the unconfirmed actions before sending more.") }
        let next = pending + [operation]; try keychain.write(next, account: ComputerStore.pendingAccount); pending = next
    }
    private func forgetMarker(_ id: String) throws {
        let next = pending.filter { $0.id != id }; try keychain.write(next, account: ComputerStore.pendingAccount); pending = next
        submitted.removeValue(forKey: id); submittedPhotos.removeValue(forKey: id)
    }
    @discardableResult private func dispatch(_ command: JSONValue, operation: PendingOperation) async -> Shell? {
        let hostID = operation.hostID, current = generations[hostID]
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
                operationFeedback("Delivery is unconfirmed. Reconnect and check the thread before sending again.", operations: [operation.id])
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
        } catch { if generations[hostID] == current { operationFeedback("Delivery to \(name(hostID)) could not be checked. Nothing was resent. Reconnect to try again.", operations: Set(scoped(hostID).map(\.id))) } }
    }
    private func operationFeedback(_ words: String, operations: Set<String>) {
        feedback = words; feedbackOperations = operations
    }
    private func settle(_ item: PendingOperation, receipt: Receipt? = nil, shell: Shell?) throws {
        // A phone-minted Sotto ID identifies this exact creation even after its receipt expired.
        if item.kind == "create-thread", shell?.host.threads.contains(where: { $0.id == item.threadID }) == true {
            try forgetMarker(item.id)
            return
        }
        let delivery = shell?.deliveries?.first { $0.threadId == item.threadID && $0.draftId == item.draftID }
        let delivered = shell?.deliveredDrafts?.contains { $0.threadId == item.threadID && $0.draftId == item.draftID } == true
        let accepted = delivered || delivery?.status == "accepted"
        let thread = shell?.host.threads.first { $0.id == item.threadID }
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
                feedback = confirmed ? "Answer sent." : Self.requestNoLongerWaiting
            }
        } else if delivery?.status == "failed" {
            try rejectOperation(item)
            // Named, because the thread open now may be another one, on another computer.
            let title = thread.map { "“\($0.title)”" } ?? "a thread"
            feedback = "Your reply to \(title) on \(name(item.hostID)) wasn’t sent. Its text is back in that thread."
        } else if accepted || receipt.map({ item.reconciled(receipt: $0, deliveries: shell?.deliveries ?? []) }) == true {
            try forgetMarker(item.id)
            if feedbackOperations.remove(item.id) != nil, feedbackOperations.isEmpty { feedback = nil }
        }
    }
    private func rejectOperation(_ operation: PendingOperation) throws {
        if let text = submitted[operation.id], operation.kind == "reply" {
            let ref = ThreadRef(hostID: operation.hostID, threadID: operation.threadID)
            failedReplies[ref.id] = text
            failedPhotos[ref.id] = submittedPhotos[operation.id]
        }
        try forgetMarker(operation.id)
    }
    func restoreReply(_ ref: ThreadRef) {
        guard (drafts[ref.id] ?? "").isEmpty, photos(ref).isEmpty, let text = failedReplies[ref.id] else { return }
        drafts[ref.id] = text; failedReplies.removeValue(forKey: ref.id)
        // Its photos come back too; any the computer may have let go are staged again when it is sent.
        // Staged again when sent: the computer may have refused it because it no longer kept a photo.
        if let photos = failedPhotos.removeValue(forKey: ref.id), !photos.isEmpty {
            draftPhotos[ref.id] = photos.map { var photo = $0; photo.staged = nil; photo.stagedAt = nil; return photo }
        }
    }
    func acknowledgeUnknown(_ id: String) {
        do { try forgetMarker(id); feedback = "Unconfirmed action dismissed. Nothing was resent." }
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
            throw ClientError.rejected("Folder browsing is unavailable. Reconnect or update Sotto on this computer.")
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
                throw ClientError.rejected("The project or model changed. Choose it again before opening a thread.")
            }
            // Validate the visible options before registering anything on the computer.
            _ = try Commands.createThread(projectID: projectID ?? "new-project", threadID: threadID, model: model,
                                          effort: effort, permissionID: permissionID, mayAnswer: mayAnswer(hostID),
                                          workingCopy: workingCopy)
            var chosenProject = projectID
            if let folder, let path = folder.path {
                guard case .listed(let fresh) = try await folders(hostID, path: .string(path)), fresh.path != nil else {
                    throw ClientError.rejected("This folder can no longer be opened. Nothing was added. Choose another folder.")
                }
                guard generations[hostID] == epoch, online(hostID) else { throw ClientError.disconnected }
                let confirmedPath = fresh.path!
                chosenProject = live[hostID]?.shell?.host.projects.first { NewThreads.sameFolder($0.path, confirmedPath, separator: fresh.separator) }?.id
                if chosenProject == nil {
                    guard let providerID = model.providerId,
                          live[hostID]?.shell?.host.providers?.first(where: { $0.id == providerID })?.capabilities.projects == true else {
                        throw ClientError.rejected("This provider cannot add a project folder. Choose another model.")
                    }
                    let command = try Commands.createProject(providerID: providerID, title: fresh.projectName, path: confirmedPath)
                    let marker = PendingOperation(hostID: hostID, clientID: computer.pairing.clientId, threadID: threadID, kind: "create-project")
                    try remember(marker)
                    guard let result = await dispatch(command, operation: marker), generations[hostID] == epoch,
                          !pending.contains(where: { $0.id == marker.id }) else {
                        creationFeedback = creationResultWords(hostID, kind: "Project registration")
                        return nil
                    }
                    chosenProject = result.host.projects.first { NewThreads.sameFolder($0.path, confirmedPath, separator: fresh.separator) && ($0.providerId == nil || $0.providerId == providerID) }?.id
                }
            }
            guard generations[hostID] == epoch, online(hostID), let chosenProject,
                  live[hostID]?.shell?.host.projects.contains(where: { $0.id == chosenProject }) == true,
                  let currentModel = creationModels(hostID).first(where: { $0.id == modelID }) else {
                throw ClientError.rejected("The project or model is no longer available. Reconnect and choose it again.")
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
                creationFeedback = creationResultWords(hostID, kind: "Thread creation")
                return nil
            }
            return ref
        } catch { creationFeedback = error.localizedDescription; return nil }
    }
    private func creationResultWords(_ hostID: String, kind: String) -> String {
        let explanation = creationFeedback.map { $0 + " " } ?? ""
        if pendingCreations.contains(where: { $0.hostID == hostID }) {
            return explanation + "\(kind) on \(name(hostID)) is unconfirmed. Nothing was resent. Close this sheet and check Threads before trying again."
        }
        return creationFeedback ?? feedback ?? "\(kind) did not finish. Choose the project and model again."
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
    /// A tapped alert opens its thread, on a computer this iPhone still holds.
    func openFromAlert(_ ref: ThreadRef) {
        guard computer(ref.hostID) != nil else { return }
        alertOpened = ref
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
        update(hostID) {
            $0.shell = next
            if let allowed = next.clientCapabilities?.mayAnswer { $0.mayAnswer = allowed }
        }
        noticeChanges(next, from: hostID)
        // Live evidence can arrive after the acknowledgement timed out. Never resend to settle it.
        // A Keychain write failure is local feedback, not a lost connection to the computer.
        for item in scoped(hostID) {
            // A connect, dispatch or solicited shell is followed by a receipt check. Keep its
            // answer markers through intervening pushes until their own receipts are read.
            if item.kind == "answer", !reconcileAnswers || connecting.contains(hostID) || dispatchingOperations.keys.contains(item.id) || (deliveryChecks[hostID] ?? 0) > 0 { continue }
            do { try settle(item, shell: next) }
            catch { feedback = error.localizedDescription }
        }
        if let selected, selected.hostID == hostID, !next.host.threads.contains(where: { $0.id == selected.threadID }) {
            cancelDetailReload(); self.selected = nil; openDetail = nil; detailProblem = nil
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
            let words = "The update from \(name(hostID)) could not be read. Reconnect to refresh it."
            update(hostID) { $0.status = .unreachable; $0.mayAnswer = false; $0.problem = words }
            watches[hostID] = nil
            connections[hostID]?.disconnect(); feedback = words
        }
    }
}
