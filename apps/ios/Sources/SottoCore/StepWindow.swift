import Foundation

/// A phone's step window on a thread (ADR-0194): its computer sends the thread from the message before its newest 200
/// steps, and Show earlier messages asks for 200 more.
public enum StepWindow {
    /// What a computer lists, and this client's hello accepts, when it cuts threads to a step window.
    public static let feature = "step-window"
    /// The request that moves this client's window on a thread back by another 200 steps. The thread is read after it.
    public static func earlier(threadID: String) -> [String: JSONValue] {
        ["op": .string("earlier-steps"), "threadId": .string(threadID)]
    }
}
