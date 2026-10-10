import Foundation

/// A terminal stays a terminal, named with the paired computer that owns its PTY (ADR-0066).
public struct TerminalRef: Hashable, Sendable {
    public let hostID: String; public let terminalID: String
    public init(hostID: String, terminalID: String) { self.hostID = hostID; self.terminalID = terminalID }
    public var id: String { hostID + "/terminal/" + terminalID }
}

public enum TerminalState: String, Decodable, Sendable {
    case starting, working, idle, needsYou = "needs-you", justFinished = "just-finished", exited
    public var words: String {
        switch self {
        case .starting: return "Starting"
        case .working: return "Working"
        case .idle: return "Idle"
        case .needsYou: return "Needs you"
        case .justFinished: return "Just finished"
        case .exited: return "Exited"
        }
    }
}

public struct TerminalApproval: Decodable, Equatable, Sendable {
    public let runId: String; public let requestId: String; public let approvalId: String
    public var valid: Bool { [runId, requestId, approvalId].allSatisfy(Terminals.validOpaqueID) }
    /// The full request identity, so a reused request ID from another run cannot inherit feedback.
    public var id: String { runId + "/" + requestId + "/" + approvalId }
}

/// The lightweight shell row never contains terminal output. Unknown providers remain display-only.
public struct TerminalSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let projectId: String; public let title: String; public let providerId: String?
    public let state: TerminalState; public let stateDetection: String; public let openedAt: Double
    public let approval: TerminalApproval?
    public var stateWords: String { providerId == nil && state == .working ? "Running" : state.words }
    public var hasAnswerChannel: Bool {
        UUID(uuidString: id) != nil && providerId == "claude" && state == .needsYou
            && stateDetection == "available" && approval?.valid == true
    }
}

/// Each display row is read separately so unknown terminal states do not break an older phone's threads.
struct TerminalRows: Decodable {
    let values: [TerminalSummary]
    let complete: Bool
    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var rows: [TerminalSummary] = []
        var complete = true
        while !c.isAtEnd {
            let rowDecoder = try c.superDecoder()
            if let row = try? TerminalSummary(from: rowDecoder), UUID(uuidString: row.id) != nil { rows.append(row) }
            else { complete = false }
        }
        values = rows
        self.complete = complete
    }
}

/// The current bottom of one supported blocking approval, read only for its Permission card.
public struct TerminalApprovalPreview: Decodable, Equatable, Sendable {
    public let terminalId: String; public let runId: String; public let requestId: String; public let approvalId: String
    public let previewId: String; public let lines: [String]
    public func matches(_ terminal: TerminalSummary) -> Bool {
        terminal.hasAnswerChannel && terminal.id == terminalId && terminal.approval?.runId == runId
            && terminal.approval?.requestId == requestId && terminal.approval?.approvalId == approvalId
            && previewId.count == 64 && previewId.allSatisfy { "0123456789abcdef".contains($0) }
            && !lines.isEmpty && lines.count <= 8 && lines.allSatisfy { $0.utf16.count <= 512 }
            && lines.joined(separator: "\n").utf16.count <= 4096
    }
}

public enum TerminalDecision: String, Sendable { case allow, deny }
public struct TerminalAnswerResult: Decodable, Sendable { public let answerDelivered: Bool }

public struct HostedTerminal: Identifiable, Sendable {
    public let ref: TerminalRef; public let computer: String; public let status: ComputerStatus
    public let project: String?; public let terminal: TerminalSummary
    public init(ref: TerminalRef, computer: String, status: ComputerStatus, project: String?, terminal: TerminalSummary) {
        self.ref = ref; self.computer = computer; self.status = status; self.project = project; self.terminal = terminal
    }
    public var id: String { ref.id }
    public var reachable: Bool { status == .online }
    public var finishedUnread: Bool { reachable && terminal.state == .justFinished }
}

public enum Terminals {
    public static func validOpaqueID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128
            && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [95, 46, 58, 45].contains($0) }
    }
    /// A stale row or a preview for another request never constructs an answer.
    public static func answer(_ decision: TerminalDecision, terminal: TerminalSummary, preview: TerminalApprovalPreview) throws -> [String: JSONValue] {
        guard preview.matches(terminal) else { throw ClientError.invalidRequest }
        return ["op": .string("answer-terminal"), "answer": .object([
            "terminalId": .string(terminal.id), "runId": .string(preview.runId), "requestId": .string(preview.requestId),
            "approvalId": .string(preview.approvalId), "previewId": .string(preview.previewId), "decision": .string(decision.rawValue)])]
    }
    public static func filtered(_ rows: [HostedTerminal], show: ComputerFilter = .all, query: String = "") -> [HostedTerminal] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return rows.filter { row in
            show.admits(row.ref.hostID) && (query.isEmpty || [row.terminal.title, row.project ?? "", row.computer,
                row.terminal.providerId ?? "", "Terminal"].joined(separator: " ").localizedStandardContains(query))
        }.sorted { left, right in
            if left.finishedUnread != right.finishedUnread { return left.finishedUnread }
            return left.terminal.openedAt > right.terminal.openedAt
        }
    }
}
