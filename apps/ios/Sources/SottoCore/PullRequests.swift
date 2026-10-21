import Foundation

/// A thread's pull request as the host's `git-pull-request` read answers it (`gitPullRequestDetailSchema` in
/// src/shared/gitPullRequests.ts), for the pull request sheet (ADR-0100). Read tolerantly: a field this build can't read
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

/// How a pull request's parts read on the sheet (ADR-0100): the checks rolled up, the three lines that say where it
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
        case "failure": return "Failed"
        case "cancelled": return "Cancelled"
        case "pending": return "Running"
        case "action-required": return "Waiting for approval"
        case "success": return "Passed"
        case "skipped": return "Skipped"
        default: return "Neutral"
        }
    }
    /// "1 failing, 1 running, 9 passed", worst first, or "No checks".
    public static func rollup(_ checks: [PullRequestDetail.Check]) -> String {
        let tones = checks.map { tone(ofCheck: $0.status) }
        let count = { (wanted: Tone) in tones.filter { $0 == wanted }.count }
        var parts: [String] = []
        if count(.failing) > 0 { parts.append("\(count(.failing)) failing") }
        if count(.running) > 0 { parts.append("\(count(.running)) running") }
        if count(.passed) > 0 { parts.append("\(count(.passed)) passed") }
        if count(.quiet) > 0 { parts.append("\(count(.quiet)) skipped") }
        return parts.isEmpty ? "No checks" : parts.joined(separator: ", ")
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
        return check.completedAt.flatMap(Stamp.date) != nil ? StepRun.duration(seconds) : StepRun.duration(seconds) + " so far"
    }
    /// The same for VoiceOver: "14 minutes 2 seconds", "6 minutes 10 seconds so far".
    public static func spokenDuration(_ check: PullRequestDetail.Check, now: Date = Date()) -> String? {
        guard let seconds = seconds(check, now: now) else { return nil }
        return check.completedAt.flatMap(Stamp.date) != nil ? StepRun.spokenDuration(seconds) : StepRun.spokenDuration(seconds) + " so far"
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
        if detail.checksUnknown && checks.isEmpty { return Line(.quiet, "Checks unknown", "GitHub did not let Sotto read the checks") }
        if checks.isEmpty { return Line(.quiet, "No checks", "GitHub reports none for this pull request") }
        let failing = checks.filter { tone(ofCheck: $0.status) == .failing }.count
        let words = rollup(checks) + (detail.checksUnknown ? ". GitHub did not let Sotto read every check" : "")
        if failing > 0 { return Line(.failing, failing == 1 ? "A check failed" : "\(failing) checks failed", words) }
        if let waiting = checks.first(where: { $0.status == "action-required" }) {
            return Line(.running, "A check is waiting", "\(waiting.name) is waiting for approval on GitHub")
        }
        if checks.contains(where: { tone(ofCheck: $0.status) == .running }) { return Line(.running, "Checks running", words) }
        if detail.checksUnknown { return Line(.quiet, "Not every check could be read", words) }
        return Line(.passed, "Checks passed", words)
    }
    /// The review line: GitHub's decision and who made it, as the desktop's merge checklist says it.
    public static func reviewLine(_ detail: PullRequestDetail) -> Line {
        // GitHub lists the reviews oldest first, so the later of two is the one that stands.
        let approved = detail.reviews.last { $0.state == "approved" }
        let changes = detail.reviews.last { $0.state == "changes_requested" }
        switch detail.reviewDecision {
        case "approved": return Line(.passed, "Approved", approved.map { "Approved by \($0.author)" } ?? "Approved")
        case "changes_requested": return Line(.failing, "Changes requested", changes.map { "\($0.author) asked for changes" } ?? "Changes were asked for")
        case "review_required":
            let why = detail.draft ? "Reviewers wait until it is ready" : detail.reviews.isEmpty ? "Nobody has reviewed it yet" : "It still needs an approving review"
            return Line(.running, "Review needed", why)
        default:
            if let changes { return Line(.quiet, "Changes requested", "\(changes.author) asked for changes. This repository does not require a review") }
            if let approved { return Line(.passed, "Approved", "Approved by \(approved.author)") }
            return Line(.passed, "No review required", "This repository merges without one")
        }
    }
    /// The merge line: merged or closed, conflicts, how far behind its base, or clean.
    public static func mergeLine(_ detail: PullRequestDetail) -> Line {
        let base = detail.baseBranch.isEmpty ? "its base" : detail.baseBranch
        if detail.state == "merged" { return Line(.passed, "Merged", "Merged into \(base)") }
        if detail.state == "closed" { return Line(.quiet, "Closed", "Closed without merging") }
        let behind = detail.behindBy.flatMap { $0 > 0 ? "\($0) \($0 == 1 ? "commit" : "commits") behind \(base)" : nil }
        switch detail.mergeable {
        case "conflicting":
            return Line(.failing, "Conflicts with \(base)", "Resolve them in the branch and push" + (behind.map { ". It is \($0)" } ?? ""))
        case "mergeable":
            if let behind { return Line(.running, behind, "No conflicts. Merges cleanly into \(base)") }
            if detail.behindBy == nil { return Line(.passed, "No conflicts", "Merges cleanly into \(base). GitHub could not compare it with \(base)") }
            return Line(.passed, "No conflicts", "Up to date with \(base) and merges cleanly")
        default:
            return Line(.running, "Checking for conflicts", "GitHub is still checking whether it merges cleanly" + (behind.map { ". It is \($0)" } ?? ""))
        }
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
        let noun = total == 1 ? "file" : "files"
        return files.count < total ? "\(files.count) of \(total) \(noun)" : "\(total) \(noun)"
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
            let who = current.startedBy == "user" ? "Started by you." : "Started by \(agent)."
            return .babysitting(title: since.map { "Babysitting since \($0)" } ?? "Babysitting",
                                detail: "\(who) Sotto sends this thread a wake-up when #\(detail.number) needs it.")
        }
        let last = ended.first { wanted != nil && Self.key($0.url) == wanted }
        if detail.state != "open" {
            let words = last.map { endedWords($0, now: now, clock: clock) }
                ?? (detail.state == "merged" ? "It merged into \(detail.baseBranch.isEmpty ? "its base" : detail.baseBranch)." : "It was closed.")
            return .finished(title: "Nothing to babysit", detail: words)
        }
        let what = "Sotto wakes this thread when a check fails, the checks pass, someone reviews, it conflicts or it merges."
        return .offered(detail: last.map { endedWords($0, now: now, clock: clock) + " " + what } ?? what)
    }
    /// Why babysitting ended, as the desktop's surface says it. The time is when babysitting ended, never the merge's.
    public static func endedWords(_ ended: ThreadBabysitEnded, now: Date = Date(), clock: (Date) -> String = PullRequests.clock) -> String {
        let when = Stamp.date(ended.endedAt).map { at(clock, $0, now: now) }
        let lead = when.map { "Ended at \($0)," } ?? "Ended"
        switch ended.reason {
        case "merged": return "\(lead) after #\(ended.number) merged."
        case "closed": return "\(lead) after #\(ended.number) was closed."
        case "comment-limit": return "\(lead) after ten wake-ups in a row brought only comments."
        case "unreadable": return "\(when.map { "Ended at \($0)" } ?? "Ended"). Sotto could not read #\(ended.number) from GitHub for about 16 minutes."
        case "switched-off": return "\(lead) when Let agents babysit pull requests was turned off in Settings."
        default: return when.map { "Ended at \($0)." } ?? "Ended."
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
