import SwiftUI
import UserNotifications

@main struct SottoApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var previews = PhotoPreviews()
    @Environment(\.scenePhase) private var phase
    init() {
        // The earlier Larger text switch becomes the Larger step of the five text sizes (ADR-0051).
        PhonePreferences().migrate()
        // Set before launch finishes, so a tapped alert that launches Sotto still reaches its thread.
        UNUserNotificationCenter.current().delegate = AlertDelegate.shared
    }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(model.draftStore).environmentObject(previews)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .overlay {
                    if phase != .active {
                        Rectangle().fill(Palette.canvas).ignoresSafeArea()
                            .overlay(Text("Sotto").font(.sotto(.title, .bold)).foregroundStyle(Palette.ink))
                    }
                }
                .task {
                    // A sent reply's photos are drawn from this iPhone's own copies until the thread is read again.
                    model.photosSent = { [weak previews] photos, ref in previews?.keep(photos, ref: ref) }
                    // Local alerts while Sotto runs (ADR-0051); the model decides what is news.
                    AlertCenter.shared.attach(model)
                    model.phase(phase)
                }
                .onChange(of: phase) { _, value in model.phase(value) }
                .modifier(PhoneDisplayPreferences())
        }
    }
}
