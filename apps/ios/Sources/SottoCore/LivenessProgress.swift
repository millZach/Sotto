/// Received bytes, complete messages and pongs confirm liveness; pending reads protect slow transfers.
public struct LivenessProgress: Sendable {
    private var silentRounds = 0
    private var requestDeadlines: [String: Double] = [:]
    public init() {}
    /// Reads that can carry a whole thread, and an image going either way, get two minutes on a slow link.
    public static func requestTimeout(operation: String) -> Double {
        ["detail", "observe", "stage-attachment", "preview"].contains(operation) ? 120 : 30
    }
    public mutating func beginRequest(id: String, operation: String, now: Double) {
        requestDeadlines[id] = now + Self.requestTimeout(operation: operation)
    }
    public mutating func finishRequest(id: String) { requestDeadlines.removeValue(forKey: id) }
    /// Returns true only after two consecutive silent rounds outside all request deadlines.
    public mutating func shouldDisconnect(now: Double, messagesAdvanced: Bool, pong: Bool, bytesAdvanced: Bool = false) -> Bool {
        requestDeadlines = requestDeadlines.filter { $0.value > now }
        if bytesAdvanced || messagesAdvanced || pong || !requestDeadlines.isEmpty { silentRounds = 0; return false }
        silentRounds += 1
        return silentRounds >= 2
    }
}
