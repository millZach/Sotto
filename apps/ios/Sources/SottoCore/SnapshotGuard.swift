import Foundation

/// Full snapshots may race live pushes or a foreground reconnect. Neither an older
/// revision nor a result from an earlier connection/selection can replace the window.
public enum SnapshotGuard {
    public static func accepts(requestGeneration: UUID, currentGeneration: UUID,
                               requestedThread: String, selectedThread: String?,
                               incomingRevision: Int?, currentRevision: Int?, changedSinceRead: Bool) -> Bool {
        guard requestGeneration == currentGeneration, requestedThread == selectedThread else { return false }
        guard let incomingRevision else { return !changedSinceRead }
        guard let currentRevision else { return true }
        return incomingRevision >= currentRevision
    }
}
