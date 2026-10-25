import Foundation

/// A thread's pull request as the host's `git-pull-request` read answers it (`gitPullRequestDetailSchema` in
/// src/shared/gitPullRequests.ts), for the pull request sheet (ADR-0102). Read tolerantly: a field this build can't read
/// is absent, a check, review or file it can't read is left out, and states stay strings so a later one still shows.
public struct PullRequestDetail: Decodable, Equatable, Sendable {
    /// One check on the head. `status` is `success`, `failure`, `cancelled`, `pending`, `action-required`, `skipped` or
    /// `neutral`. A check run's times say how long it took; a status another service posted, and an older host, name none.
    public struct Check: Decodable, Equatable, Sendable {
        public let name: String
        public let status: String
        public let url: String?
        public let description: String?
        public let startedAt: String?
        public let completedAt: String?
        private enum Keys: String, CodingKey { case name, status, url, description, startedAt, completedAt }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = try c.decode(String.self, forKey: .name)
            status = try c.decode(String.self, forKey: .status)
            url = c.readIfPresent(String.self, .url)
            description = c.readIfPresent(String.self, .description)
            startedAt = c.readIfPresent(String.self, .startedAt)
            completedAt = c.readIfPresent(String.self, .completedAt)
        }
    }
    /// A reviewer's latest review that took a side: `approved` or `changes_requested`.
    public struct Review: Decodable, Equatable, Sendable {
        public let author: String
        public let state: String
        public let url: String?
        private enum Keys: String, CodingKey { case author, state, url }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            author = try c.decode(String.self, forKey: .author)
            state = try c.decode(String.self, forKey: .state)
            url = c.readIfPresent(String.self, .url)
        }
    }
    /// One changed file with the lines it adds and removes.
    public struct File: Decodable, Equatable, Sendable {
        public let path: String
        public let additions: Int
        public let deletions: Int
        private enum Keys: String, CodingKey { case path, additions, deletions }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            path = try c.decode(String.self, forKey: .path)
            additions = max(0, c.readIfPresent(Int.self, .additions) ?? 0)
            deletions = max(0, c.readIfPresent(Int.self, .deletions) ?? 0)
        }
        /// The file's own name, the last part of its path.
        public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
        /// The folder it is in, or nil at the top of the repository.
        public var folder: String? {
            let parts = path.split(separator: "/")
            return parts.count > 1 ? parts.dropLast().joined(separator: "/") : nil
        }
    }

    public let number: Int
    public let url: String
    public let title: String
    public let body: String
    /// `open`, `closed` or `merged`.
    public let state: String
    public let draft: Bool
    public let baseBranch: String
    public let headBranch: String
    /// `approved`, `changes_requested`, `review_required`, or nil where the repository requires no review.
    public let reviewDecision: String?
    public let reviews: [Review]
    /// `mergeable`, `conflicting` or `unknown`.
    public let mergeable: String
    public let checks: [Check]
    /// GitHub refused the checks, or one of them, so `checks` holds only those it returned.
    public let checksUnknown: Bool
    public let mergedAt: String?
    /// Commits the base has that the head lacks; nil when GitHub could not compare them.
    public let behindBy: Int?
    /// The first hundred changed files, and how many it changes in all. Nil from a host before #1281, or when GitHub did
    /// not list them: not known, rather than none.
    public let files: [File]?
    public let changedFiles: Int?

    private enum Keys: String, CodingKey {
        case number, url, title, body, state, draft, baseBranch, headBranch, reviewDecision, reviews, mergeable, checks, checksUnknown
        case mergedAt, behindBy, files, changedFiles
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        number = try c.decode(Int.self, forKey: .number)
        url = try c.decode(String.self, forKey: .url)
        title = try c.decode(String.self, forKey: .title)
        body = c.readIfPresent(String.self, .body) ?? ""
        state = c.readIfPresent(String.self, .state) ?? "open"
        draft = c.readIfPresent(Bool.self, .draft) ?? false
        baseBranch = c.readIfPresent(String.self, .baseBranch) ?? ""
        headBranch = c.readIfPresent(String.self, .headBranch) ?? ""
        reviewDecision = c.readIfPresent(String.self, .reviewDecision)
        reviews = c.readIfPresent([PullRequestItem<Review>].self, .reviews)?.compactMap(\.value) ?? []
        mergeable = c.readIfPresent(String.self, .mergeable) ?? "unknown"
        checks = c.readIfPresent([PullRequestItem<Check>].self, .checks)?.compactMap(\.value) ?? []
        checksUnknown = c.readIfPresent(Bool.self, .checksUnknown) ?? false
        mergedAt = c.readIfPresent(String.self, .mergedAt)
        behindBy = c.readIfPresent(Int.self, .behindBy)
        files = c.readIfPresent([PullRequestItem<File>].self, .files)?.compactMap(\.value)
        changedFiles = c.readIfPresent(Int.self, .changedFiles)
    }

    /// `draft` for an open draft, else the state: what the chip and the state pill say.
    public var shownState: String { state == "open" && draft ? "draft" : state }
}

/// What a `git-pull-request` read answers: the detail, a refusal GitHub's rate limit made with when to ask again, or none
/// when the thread has no pull request to show.
public enum PullRequestRead: Decodable, Equatable, Sendable {
    case detail(PullRequestDetail)
    case limited(retryAt: String)
    case noPullRequest
    private struct Limited: Decodable { let limited: Inner; struct Inner: Decodable { let retryAt: String } }
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .noPullRequest; return }
        if let limited = try? c.decode(Limited.self) { self = .limited(retryAt: limited.limited.retryAt); return }
        self = .detail(try c.decode(PullRequestDetail.self))
    }
}

/// A pull request a thread babysits, as the host sends it on the thread (`agentBabysittingSchema`, ADR-0061).
public struct ThreadBabysitting: Decodable, Equatable, Sendable {
    public let url: String
    public let number: Int
    /// `agent` or `user`.
    public let startedBy: String
    public let startedAt: String
}
/// Why babysitting a pull request last ended on its own (`agentBabysitEndedSchema`): `merged`, `closed`,
/// `comment-limit`, `unreadable` or `switched-off`.
public struct ThreadBabysitEnded: Decodable, Equatable, Sendable {
    public let url: String
    public let number: Int
    public let reason: String
    public let endedAt: String
}
/// A list on a thread read item by item: one this build can't read is left out, and a list that isn't one reads as
/// empty, so a later host's record never fails the thread.
public struct ThreadList<Item: Decodable & Equatable & Sendable>: Decodable, Equatable, Sendable {
    public let items: [Item]
    public init(_ items: [Item]) { self.items = items }
    public init(from decoder: Decoder) throws {
        items = (try? decoder.singleValueContainer().decode([PullRequestItem<Item>].self))?.compactMap(\.value) ?? []
    }
}
/// One element of a list read on its own: nil when it cannot be read, so the rest of the list still is.
struct PullRequestItem<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is missing, null or of another type.
    func readIfPresent<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let value = try? decodeIfPresent(type, forKey: key) else { return nil }
        return value
    }
}

/// How a pull request's parts read on the sheet (ADR-0102): the checks rolled up, the three lines that say where it
/// stands, the order of its checks and files, and how long a check took, in the words of the desktop's Pull request
/// surface where it says the same thing.
public enum PullRequests {
    /// How a line or a check stands: something failed, something is still running or waits on someone, it passed, or
    /// it says nothing either way (skipped, unknown, closed).
    public enum Tone: Equatable, Sendable { case failing, running, passed, quiet }
    /// A line of the sheet's summary: its mark, its title and the sentence under it.
    public struct Line: Equatable, Sendable {
        public let tone: Tone
        public let title: String
        public let detail: String
        public init(_ tone: Tone, _ title: String, _ detail: String) { self.tone = tone; self.title = title; self.detail = detail }
    }

    /// The request that reads a thread's pull request by its URL, through the host's `gh`.
    public static func request(threadID: String, url: String) throws -> [String: JSONValue] {
        guard address(url) != nil else { throw ClientError.invalidRequest }
        return ["op": .string("git-pull-request"), "request": .object(["threadId": .string(threadID), "reference": .string(url)])]
    }
    /// `owner/name#number`, lowercased, for a GitHub pull request URL: the one spelling two URLs of the same pull request
    /// share, as the host keys its babysitting records (`pullRequestKey`). Nil for anything else.
    public static func key(_ url: String) -> String? {
        guard let found = address(url) else { return nil }
        return "\(found.owner)/\(found.name)#\(found.number)".lowercased()
    }
    /// The pull request's own page on GitHub, or nil for a URL that isn't one.
    public static func address(_ url: String) -> (owner: String, name: String, number: Int)? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), parts.scheme?.lowercased() == "https", parts.host?.lowercased() == "github.com" else { return nil }
        let path = parts.path.split(separator: "/").map(String.init)
        guard path.count >= 4, path[2] == "pull", let number = Int(path[3]), number > 0 else { return nil }
        return (path[0], path[1], number)
    }
    /// A link the sheet may open: GitHub, or another HTTPS page a check named, never anything else.
    public static func openable(_ url: String?) -> URL? {
        guard let url, let parsed = URL(string: url), parsed.scheme?.lowercased() == "https", parsed.host != nil else { return nil }
        return parsed
    }

    // MARK: Checks

    public static func tone(ofCheck status: String) -> Tone {
        switch status {
        case "failure", "cancelled": return .failing
        case "pending", "action-required": return .running
        case "success": return .passed
        default: return .quiet
        }
    }
    /// What a check's state says in words.
    public static func checkWord(_ status: String) -> String {
        switch status {
        case "failure": return String(localized: "Failed", bundle: .module, comment: "A pull request check's state")
        case "cancelled": return String(localized: "Cancelled", bundle: .module, comment: "A pull request check's state")
        case "pending": return String(localized: "Running", bundle: .module, comment: "A pull request check's state: it is still going")
        case "action-required": return String(localized: "Waiting for approval", bundle: .module, comment: "A pull request check's state")
        case "success": return String(localized: "Passed", bundle: .module, comment: "A pull request check's state")
        case "skipped": return String(localized: "Skipped", bundle: .module, comment: "A pull request check's state")
        default: return String(localized: "Neutral", bundle: .module, comment: "A pull request check's state: it neither passed nor failed")
        }
    }
    /// "1 failing, 1 running, 9 passed", worst first, or "No checks".
    public static func rollup(_ checks: [PullRequestDetail.Check]) -> String {
        let tones = checks.map { tone(ofCheck: $0.status) }
        let count = { (wanted: Tone) in tones.filter { $0 == wanted }.count }
        var parts: [String] = []
        let failing = count(.failing), running = count(.running), passed = count(.passed), skipped = count(.quiet)
        if failing > 0 {
            parts.append(failing == 1 ? String(localized: "1 failing", bundle: .module, comment: "How many of a pull request's checks are failing")
                : String(localized: "\(failing) failing", bundle: .module, comment: "How many of a pull request's checks are failing"))
        }
        if running > 0 {
            parts.append(running == 1 ? String(localized: "1 running", bundle: .module, comment: "How many of a pull request's checks are still running")
                : String(localized: "\(running) running", bundle: .module, comment: "How many of a pull request's checks are still running"))
        }
        if passed > 0 {
            parts.append(passed == 1 ? String(localized: "1 passed", bundle: .module, comment: "How many of a pull request's checks passed")
                : String(localized: "\(passed) passed", bundle: .module, comment: "How many of a pull request's checks passed"))
        }
        if skipped > 0 {
            parts.append(skipped == 1 ? String(localized: "1 skipped", bundle: .module, comment: "How many of a pull request's checks were skipped")
                : String(localized: "\(skipped) skipped", bundle: .module, comment: "How many of a pull request's checks were skipped"))
        }
        return parts.isEmpty ? String(localized: "No checks", bundle: .module) : parts.joined(separator: ", ")
    }
    /// The chip's dot: failing, running or passed, or nil when there are no checks to say anything about.
    public static func dot(_ detail: PullRequestDetail) -> Tone? {
        let tones = detail.checks.map { tone(ofCheck: $0.status) }
        if tones.contains(.failing) { return .failing }
        if tones.contains(.running) { return .running }
        if tones.contains(.passed) { return .passed }
        return nil
    }
    /// The checks, those that are not passed first (failing, then running, then skipped), each group in GitHub's order.
    public static func ordered(_ checks: [PullRequestDetail.Check]) -> [PullRequestDetail.Check] {
        let rank: (Tone) -> Int = { tone in
            switch tone { case .failing: return 0; case .running: return 1; case .quiet: return 2; case .passed: return 3 }
        }
        return checks.enumerated().sorted { a, b in
            let left = rank(tone(ofCheck: a.element.status)), right = rank(tone(ofCheck: b.element.status))
            return left != right ? left < right : a.offset < b.offset
        }.map(\.element)
    }
    /// How long a check took, "14m 02s", or has taken so far, "6m 10s so far"; nil when GitHub gave no start.
    public static func duration(_ check: PullRequestDetail.Check, now: Date = Date()) -> String? {
        guard let seconds = seconds(check, now: now) else { return nil }
        let length = StepRun.duration(seconds)
        return check.completedAt.flatMap(Stamp.date) != nil ? length
            : String(localized: "\(length) so far", bundle: .module, comment: "How long a check that is still running has taken, such as 6m 10s so far")
    }
    /// The same for VoiceOver: "14 minutes 2 seconds", "6 minutes 10 seconds so far".
    public static func spokenDuration(_ check: PullRequestDetail.Check, now: Date = Date()) -> String? {
        guard let seconds = seconds(check, now: now) else { return nil }
        let length = StepRun.spokenDuration(seconds)
        return check.completedAt.flatMap(Stamp.date) != nil ? length
            : String(localized: "\(length) so far", bundle: .module, comment: "How long a check that is still running has taken, such as 6m 10s so far")
    }
    private static func seconds(_ check: PullRequestDetail.Check, now: Date) -> TimeInterval? {
        guard let start = check.startedAt.flatMap(Stamp.date) else { return nil }
        let end = check.completedAt.flatMap(Stamp.date)
        // A check that finished has a length; one still going is counted to now. One that ended without a time says nothing.
        if end == nil && tone(ofCheck: check.status) != .running { return nil }
        return max(0, (end ?? now).timeIntervalSince(start))
    }

    // MARK: Where it stands

    /// The checks line: whether any failed or still runs, with the roll-up under it.
    public static func checksLine(_ detail: PullRequestDetail) -> Line {
        let checks = detail.checks
        if detail.checksUnknown && checks.isEmpty {
            return Line(.quiet, String(localized: "Checks unknown", bundle: .module), String(localized: "GitHub did not let Sotto read the checks", bundle: .module))
        }
        if checks.isEmpty {
            return Line(.quiet, String(localized: "No checks", bundle: .module), String(localized: "GitHub reports none for this pull request", bundle: .module))
        }
        let failing = checks.filter { tone(ofCheck: $0.status) == .failing }.count
        let rolled = rollup(checks)
        let words = detail.checksUnknown
            ? String(localized: "\(rolled). GitHub did not let Sotto read every check", bundle: .module,
                     comment: "%@ is how the checks stand, such as 1 failing, 9 passed")
            : rolled
        if failing > 0 {
            let title = failing == 1 ? String(localized: "A check failed", bundle: .module)
                : String(localized: "\(failing) checks failed", bundle: .module)
            return Line(.failing, title, words)
        }
        if let waiting = checks.first(where: { $0.status == "action-required" }) {
            return Line(.running, String(localized: "A check is waiting", bundle: .module),
                        String(localized: "\(waiting.name) is waiting for approval on GitHub", bundle: .module,
                               comment: "%@ is the check's name on GitHub"))
        }
        if checks.contains(where: { tone(ofCheck: $0.status) == .running }) {
            return Line(.running, String(localized: "Checks running", bundle: .module), words)
        }
        if detail.checksUnknown { return Line(.quiet, String(localized: "Not every check could be read", bundle: .module), words) }
        return Line(.passed, String(localized: "Checks passed", bundle: .module), words)
    }
    /// The review line: GitHub's decision and who made it, as the desktop's merge checklist says it.
    public static func reviewLine(_ detail: PullRequestDetail) -> Line {
        // GitHub lists the reviews oldest first, so the later of two is the one that stands.
        let approved = detail.reviews.last { $0.state == "approved" }
        let changes = detail.reviews.last { $0.state == "changes_requested" }
        let approvedWord = String(localized: "Approved", bundle: .module, comment: "A pull request's review decision")
        let changesWord = String(localized: "Changes requested", bundle: .module, comment: "A pull request's review decision")
        switch detail.reviewDecision {
        case "approved":
            return Line(.passed, approvedWord, approved.map { approvedBy($0.author) } ?? approvedWord)
        case "changes_requested":
            return Line(.failing, changesWord, changes.map { askedForChanges($0.author) } ?? String(localized: "Changes were asked for", bundle: .module))
        case "review_required":
            let why = detail.draft ? String(localized: "Reviewers wait until it is ready", bundle: .module)
                : detail.reviews.isEmpty ? String(localized: "Nobody has reviewed it yet", bundle: .module)
                : String(localized: "It still needs an approving review", bundle: .module)
            return Line(.running, String(localized: "Review needed", bundle: .module), why)
        default:
            if let changes {
                return Line(.quiet, changesWord,
                            String(localized: "\(changes.author) asked for changes. This repository does not require a review", bundle: .module,
                                   comment: "%@ is the reviewer's GitHub name"))
            }
            if let approved { return Line(.passed, approvedWord, approvedBy(approved.author)) }
            return Line(.passed, String(localized: "No review required", bundle: .module), String(localized: "This repository merges without one", bundle: .module))
        }
    }
    private static func approvedBy(_ author: String) -> String {
        String(localized: "Approved by \(author)", bundle: .module, comment: "%@ is the reviewer's GitHub name")
    }
    private static func askedForChanges(_ author: String) -> String {
        String(localized: "\(author) asked for changes", bundle: .module, comment: "%@ is the reviewer's GitHub name")
    }
    /// The merge line: merged or closed, conflicts, how far behind its base, or clean.
    public static func mergeLine(_ detail: PullRequestDetail) -> Line {
        let base = baseName(detail)
        if detail.state == "merged" {
            return Line(.passed, String(localized: "Merged", bundle: .module, comment: "A pull request's state"),
                        String(localized: "Merged into \(base)", bundle: .module, comment: "%@ is the base branch's name, or its base"))
        }
        if detail.state == "closed" {
            return Line(.quiet, String(localized: "Closed", bundle: .module, comment: "A pull request's state"),
                        String(localized: "Closed without merging", bundle: .module))
        }
        let behind = detail.behindBy.flatMap { count -> String? in
            guard count > 0 else { return nil }
            let commits = count == 1 ? String(localized: "1 commit", bundle: .module) : String(localized: "\(count) commits", bundle: .module)
            return String(localized: "\(commits) behind \(base)", bundle: .module,
                          comment: "The first %@ is how many commits, such as 3 commits; the second is the base branch's name, or its base")
        }
        let noConflicts = String(localized: "No conflicts", bundle: .module)
        switch detail.mergeable {
        case "conflicting":
            let what = behind.map {
                String(localized: "Resolve them in the branch and push. It is \($0)", bundle: .module,
                       comment: "%@ is how far behind its base the pull request is, such as 3 commits behind main")
            } ?? String(localized: "Resolve them in the branch and push", bundle: .module)
            return Line(.failing, String(localized: "Conflicts with \(base)", bundle: .module, comment: "%@ is the base branch's name, or its base"), what)
        case "mergeable":
            if let behind {
                return Line(.running, behind, String(localized: "No conflicts. Merges cleanly into \(base)", bundle: .module,
                                                     comment: "%@ is the base branch's name, or its base"))
            }
            if detail.behindBy == nil {
                return Line(.passed, noConflicts, String(localized: "Merges cleanly into \(base). GitHub could not compare it with \(base)", bundle: .module,
                                                         comment: "Both %@ are the base branch's name, or its base"))
            }
            return Line(.passed, noConflicts, String(localized: "Up to date with \(base) and merges cleanly", bundle: .module,
                                                     comment: "%@ is the base branch's name, or its base"))
        default:
            let what = behind.map {
                String(localized: "GitHub is still checking whether it merges cleanly. It is \($0)", bundle: .module,
                       comment: "%@ is how far behind its base the pull request is, such as 3 commits behind main")
            } ?? String(localized: "GitHub is still checking whether it merges cleanly", bundle: .module)
            return Line(.running, String(localized: "Checking for conflicts", bundle: .module), what)
        }
    }
    /// The base branch's name, set apart from the words around it, or "its base" when GitHub gave none.
    private static func baseName(_ detail: PullRequestDetail) -> String {
        detail.baseBranch.isEmpty
            ? String(localized: "its base", bundle: .module, comment: "Stands in for a pull request's base branch when GitHub doesn't name it, as in Merged into its base")
            : Interface.isolated(detail.baseBranch)
    }

    // MARK: Files

    /// The files, the most changed first, then by path.
    public static func ordered(_ files: [PullRequestDetail.File]) -> [PullRequestDetail.File] {
        files.sorted { a, b in
            let left = a.additions + a.deletions, right = b.additions + b.deletions
            return left != right ? left > right : a.path < b.path
        }
    }
    /// "3 files", or "100 of 312 files" when GitHub listed only some.
    public static func fileCount(_ detail: PullRequestDetail) -> String? {
        guard let files = detail.files else { return nil }
        let total = max(detail.changedFiles ?? files.count, files.count)
        let all = total == 1 ? String(localized: "1 file", bundle: .module) : String(localized: "\(total) files", bundle: .module)
        guard files.count < total else { return all }
        return String(localized: "\(files.count) of \(all)", bundle: .module,
                      comment: "How many of a pull request's files GitHub listed; %lld is how many it listed, %@ how many there are, such as 312 files")
    }

    // MARK: Babysitting

    /// The line docked at the bottom of the sheet (ADR-0061's words): while it babysits, since when and who started it;
    /// once it ended on its own, why; otherwise what babysitting does. `clock` says a time the phone's way.
    public enum BabysitState: Equatable, Sendable {
        /// Babysitting now; Stop babysitting is offered.
        case babysitting(title: String, detail: String)
        /// Not babysitting an open pull request; Babysit pull request is offered.
        case offered(detail: String)
        /// Merged or closed: nothing to babysit, and no control.
        case finished(title: String, detail: String)
    }
    public static func babysitState(babysitting: [ThreadBabysitting], ended: [ThreadBabysitEnded], detail: PullRequestDetail,
                                    agent: String, now: Date = Date(), clock: (Date) -> String = PullRequests.clock) -> BabysitState {
        let wanted = Self.key(detail.url)
        if let current = babysitting.first(where: { wanted != nil && Self.key($0.url) == wanted }) {
            let since = Stamp.date(current.startedAt).map { at(clock, $0, now: now) }
            let who = current.startedBy == "user" ? String(localized: "Started by you.", bundle: .module, comment: "Who started babysitting a pull request")
                : String(localized: "Started by \(agent).", bundle: .module, comment: "Who started babysitting a pull request; %@ is the agent's name, such as Codex")
            let title = since.map {
                String(localized: "Babysitting since \($0)", bundle: .module, comment: "%@ is when babysitting started, such as 2:02 PM or Oct 7, 2:02 PM")
            } ?? String(localized: "Babysitting", bundle: .module, comment: "Sotto is watching this thread's pull request for it")
            let wakes = String(localized: "Sotto sends this thread a wake-up when #\(String(detail.number)) needs it.", bundle: .module,
                               comment: "%@ is the pull request's number")
            return .babysitting(title: title, detail: who + " " + wakes)
        }
        let last = ended.first { wanted != nil && Self.key($0.url) == wanted }
        if detail.state != "open" {
            let words = last.map { endedWords($0, now: now, clock: clock) }
                ?? (detail.state == "merged"
                    ? String(localized: "It merged into \(baseName(detail)).", bundle: .module, comment: "%@ is the base branch's name, or its base")
                    : String(localized: "It was closed.", bundle: .module, comment: "A pull request that was closed without merging"))
            return .finished(title: String(localized: "Nothing to babysit", bundle: .module), detail: words)
        }
        let what = String(localized: "Sotto wakes this thread when a check fails, the checks pass, someone reviews, it conflicts or it merges.", bundle: .module)
        return .offered(detail: last.map { endedWords($0, now: now, clock: clock) + " " + what } ?? what)
    }
    /// Why babysitting ended, as the desktop's surface says it. The time is when babysitting ended, never the merge's.
    public static func endedWords(_ ended: ThreadBabysitEnded, now: Date = Date(), clock: (Date) -> String = PullRequests.clock) -> String {
        let when = Stamp.date(ended.endedAt).map { at(clock, $0, now: now) }
        // As text: a locale would group a number of four digits, #1,287.
        let number: String = String(ended.number)
        // Each reason is one sentence with the time and one without, so every language words both whole.
        switch ended.reason {
        case "merged":
            return when.map {
                String(localized: "Ended at \($0), after #\(number) merged.", bundle: .module,
                       comment: "Why babysitting ended; %@ is when, such as 2:02 PM, and the second %@ is the pull request's number")
            } ?? String(localized: "Ended after #\(number) merged.", bundle: .module, comment: "Why babysitting ended; %@ is the pull request's number")
        case "closed":
            return when.map {
                String(localized: "Ended at \($0), after #\(number) was closed.", bundle: .module,
                       comment: "Why babysitting ended; %@ is when, such as 2:02 PM, and the second %@ is the pull request's number")
            } ?? String(localized: "Ended after #\(number) was closed.", bundle: .module, comment: "Why babysitting ended; %@ is the pull request's number")
        case "comment-limit":
            return when.map {
                String(localized: "Ended at \($0), after ten wake-ups in a row brought only comments.", bundle: .module,
                       comment: "Why babysitting ended; %@ is when, such as 2:02 PM")
            } ?? String(localized: "Ended after ten wake-ups in a row brought only comments.", bundle: .module)
        case "unreadable":
            return when.map {
                String(localized: "Ended at \($0). Sotto could not read #\(number) from GitHub for about 16 minutes.", bundle: .module,
                       comment: "Why babysitting ended; %@ is when, such as 2:02 PM, and the second %@ is the pull request's number")
            } ?? String(localized: "Ended. Sotto could not read #\(number) from GitHub for about 16 minutes.", bundle: .module,
                        comment: "Why babysitting ended; %@ is the pull request's number")
        case "switched-off":
            return when.map {
                String(localized: "Ended at \($0), when Let agents babysit pull requests was turned off in Settings.", bundle: .module,
                       comment: "Why babysitting ended; %@ is when, such as 2:02 PM. Let agents babysit pull requests is a setting's name")
            } ?? String(localized: "Ended when Let agents babysit pull requests was turned off in Settings.", bundle: .module,
                        comment: "Why babysitting ended. Let agents babysit pull requests is a setting's name")
        default:
            return when.map {
                String(localized: "Ended at \($0).", bundle: .module, comment: "Babysitting ended; %@ is when, such as 2:02 PM")
            } ?? String(localized: "Ended.", bundle: .module, comment: "Babysitting ended")
        }
    }
    /// What the sheet says when `computer` could not read the pull request from GitHub (#1290): what happened, that
    /// nothing was lost, and what to do next, by the reason the host gave. A host before #1290 gives none, so its words
    /// name every cause. No sentence starts with the computer's name, which may be "the computer".
    public static func readFailureWords(reason: String?, computer: String) -> String {
        switch reason {
        case "gh-missing":
            return String(localized: "GitHub’s command line tool, gh, isn’t installed on \(computer), so Sotto couldn’t read the pull request. Nothing was lost. Install gh there and sign in with gh auth login, then try again.", bundle: .module,
                          comment: "Every %@ is the computer's name, or the computer")
        case "gh-signed-out":
            return String(localized: "gh isn’t signed in to GitHub on \(computer), so Sotto couldn’t read the pull request. Nothing was lost. Sign in to GitHub on \(computer) with gh auth login, then try again.", bundle: .module,
                          comment: "Every %@ is the computer's name, or the computer")
        case "offline":
            return String(localized: "GitHub can’t be reached from \(computer) right now, so Sotto couldn’t read the pull request. Nothing was lost. Try again when it’s back online.", bundle: .module,
                          comment: "Every %@ is the computer's name, or the computer")
        case "unreadable":
            return String(localized: "GitHub didn’t give \(computer) this pull request. Nothing was lost. Try again in a moment, or open it on GitHub to check it still exists.", bundle: .module,
                          comment: "Every %@ is the computer's name, or the computer")
        default:
            return String(localized: "Sotto couldn’t read the pull request from GitHub on \(computer). Nothing was lost. Check that gh is installed and signed in there and can reach GitHub, then try again.", bundle: .module,
                          comment: "Every %@ is the computer's name, or the computer")
        }
    }
    /// "2:02 PM" today, or "Oct 7, 2:02 PM" before.
    private static func at(_ clock: (Date) -> String, _ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now) ? clock(date) : day.string(from: date) + ", " + clock(date)
    }
    private static let day: DateFormatter = {
        let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("MMMd"); return f
    }()
    private static let time: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()
    /// A time of day the phone's way.
    public static func clock(_ date: Date) -> String { time.string(from: date) }
}
