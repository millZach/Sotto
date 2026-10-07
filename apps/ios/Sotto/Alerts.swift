import Foundation
import UserNotifications
import SottoCore

/// Where an alert keeps the thread it names. Only these two IDs ride on an alert, never a message's words.
private let alertHostKey = "hostID"
private let alertThreadKey = "threadID"

/// Local alerts through iOS's notification centre (ADR-0051). Nothing here uses Apple's push service or needs an
/// entitlement: an alert is posted on this iPhone, while Sotto runs, and names only the thread, its agent and its
/// computer. Nothing here logs.
@MainActor final class AlertCenter: AlertPosting {
    static let shared = AlertCenter()
    private weak var model: AppModel?
    /// A thread whose alert was tapped before the model was handed over, at launch.
    private var waiting: ThreadRef?

    /// Hands over the model, which posts alerts and opens a tapped alert's thread.
    func attach(_ model: AppModel) {
        self.model = model
        model.alerts = self
        if let waiting {
            self.waiting = nil
            model.openFromAlert(waiting)
        }
    }
    var threadOnScreen: ThreadRef? { model?.threadOnScreen }
    func open(_ ref: ThreadRef) {
        if let model { model.openFromAlert(ref) } else { waiting = ref }
    }

    func permission() async -> AlertPermission {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        switch status {
        case .notDetermined: return .undecided
        case .denied: return .denied
        default: return .allowed
        }
    }
    func requestPermission() async -> Bool {
        do { return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
        catch { return false }
    }
    func post(_ alert: ThreadAlert, sound: Bool) {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.threadIdentifier = alert.ref.id
        content.userInfo = [alertHostKey: alert.ref.hostID, alertThreadKey: alert.ref.threadID]
        if sound { content.sound = UNNotificationSound.default }
        let request = UNNotificationRequest(identifier: alert.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    /// The thread an alert names, read from what `post` put on it.
    nonisolated static func ref(_ info: [AnyHashable: Any]) -> ThreadRef? {
        guard let host = info[alertHostKey] as? String, let thread = info[alertThreadKey] as? String else { return nil }
        return ThreadRef(hostID: host, threadID: thread)
    }
}

/// iOS asks this how to show an alert while Sotto is open, and tells it when one is tapped. An alert for the thread
/// on screen shows nothing; a tapped alert opens its thread.
final class AlertDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AlertDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let ref = AlertCenter.ref(notification.request.content.userInfo)
        Task { @MainActor in
            let onScreen = ref != nil && ref == AlertCenter.shared.threadOnScreen
            completionHandler(onScreen ? [] : [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let ref = AlertCenter.ref(response.notification.request.content.userInfo)
        Task { @MainActor in
            if let ref { AlertCenter.shared.open(ref) }
            completionHandler()
        }
    }
}
