import Foundation

/// The chips under a thread's title: its branch, the folder's changed lines and its pull request, from the Git status
/// the host keeps on the thread's worktree record. A chip with nothing to say is left out. The pull request chip opens
/// the pull request sheet where the computer offers it (ADR-0102), and says its checks once the sheet has read them.
public struct GitChips: Equatable, Sendable {
    public struct Changes: Equatable, Sendable {
        public let files: Int
        public let insertions: Int
        public let deletions: Int
    }
    public struct PullRequest: Equatable, Sendable {
        public let number: Int
        /// `draft`, `open`, `merged` or `closed`.
        public let state: String
        /// The state as the chip says it, in the interface language.
        public var stateWord: String {
            switch state {
            case "draft": return String(localized: "draft", bundle: .module, comment: "A pull request's state on its chip, as in #721 draft")
            case "merged": return String(localized: "pull-request-chip.merged", defaultValue: "merged", bundle: .module, comment: "A pull request's state on its chip, as in #721 merged")
            case "closed": return String(localized: "pull-request-chip.closed", defaultValue: "closed", bundle: .module, comment: "A pull request's state on its chip, as in #721 closed")
            default: return String(localized: "open", bundle: .module, comment: "A pull request's state on its chip, as in #721 open")
            }
        }
    }

    public let branch: String?
    public let changes: Changes?
    public let pullRequest: PullRequest?
    /// The pull request's GitHub URL, which the sheet reads it by; nil when the host's record names none that is one.
    public let pullRequestURL: String?

    public init(_ worktree: ThreadWorktree?) {
        let git = worktree?.git
        let named = [git?.branch, worktree?.branch].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        branch = named.first { !$0.isEmpty }
        if let git {
            let files = max(0, git.changedFiles ?? 0)
            let insertions = max(0, git.insertions ?? 0)
            let deletions = max(0, git.deletions ?? 0)
            changes = files + insertions + deletions > 0 ? Changes(files: files, insertions: insertions, deletions: deletions) : nil
        } else {
            changes = nil
        }
        if let request = git?.pullRequest, let number = request.number, number > 0 {
            let state: String
            switch request.state ?? "" {
            case "merged": state = "merged"
            case "closed": state = "closed"
            default: state = request.draft == true ? "draft" : "open"
            }
            pullRequest = PullRequest(number: number, state: state)
            pullRequestURL = request.url.flatMap { PullRequests.address($0) != nil ? $0 : nil }
        } else {
            pullRequest = nil
            pullRequestURL = nil
        }
    }

    public var isEmpty: Bool { branch == nil && changes == nil && pullRequest == nil }

    /// The row as VoiceOver reads it.
    public var spoken: String { spoken(includingPullRequest: true) }
    /// The row as VoiceOver reads it, leaving the pull request out when its chip is a button of its own.
    public func spoken(includingPullRequest: Bool) -> String {
        var parts: [String] = []
        if let branch {
            parts.append(String(localized: "Branch \(Interface.isolated(branch))", bundle: .module, comment: "%@ is the branch's name"))
        }
        if let changes {
            let files = changes.files == 1 ? String(localized: "1 file changed", bundle: .module)
                : String(localized: "\(changes.files) files changed", bundle: .module)
            let added = changes.insertions == 1 ? String(localized: "1 line added", bundle: .module)
                : String(localized: "\(changes.insertions) lines added", bundle: .module)
            let removed = changes.deletions == 1 ? String(localized: "1 removed", bundle: .module, comment: "How many lines were removed")
                : String(localized: "\(changes.deletions) removed", bundle: .module, comment: "How many lines were removed")
            parts.append(String(localized: "\(files), \(added), \(removed)", bundle: .module,
                                comment: "A thread's changes for VoiceOver, such as 7 files changed, 212 lines added, 48 removed"))
        }
        if includingPullRequest, let pullRequest {
            parts.append(String(localized: "Pull request \(String(pullRequest.number)), \(pullRequest.stateWord)", bundle: .module,
                                comment: "The first %@ is the pull request's number, the second its state, such as open or draft"))
        }
        return parts.joined(separator: ". ")
    }
}
