import SwiftUI
import QuickLook
import UserNotifications
import SottoCore

@main struct SottoApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var previews = PhotoPreviews()
    @StateObject private var files = SentFiles()
    @Environment(\.scenePhase) private var phase
    init() {
        // The earlier Larger text switch becomes the Larger step of the five text sizes (ADR-0051).
        PhonePreferences().migrate()
        // Set before launch finishes, so a tapped alert that launches Sotto still reaches its thread.
        UNUserNotificationCenter.current().delegate = AlertDelegate.shared
    }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(model.draftStore).environmentObject(model.detailStore)
                .environmentObject(model.watcherStore)
                .environmentObject(previews)
                .environmentObject(files)
                // A sent file opens in Quick Look over whatever is showing; its copy goes when the preview closes.
                .quickLookPreview($files.shown)
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
                    if phase == .active { model.takeShares() }
                }
                .onChange(of: phase) { _, value in
                    model.phase(value)
                    if value == .active { model.takeShares() }
                    if value == .background { files.background() }
                }
                // Share to Sotto opens the app with this when it has left something in the inbox (ADR-0157).
                .onOpenURL { url in if url.scheme == ShareInbox.openURL.scheme { model.takeShares() } }
                .modifier(PhoneDisplayPreferences())
                // In Arabic and Urdu the window keeps its English layout; only paragraph text runs right to left,
                // inside its own box (`paragraphDirection()`). Fonts follow the interface language, so Chinese and
                // Japanese get their own glyph shapes (ADR-0123).
                .environment(\.layoutDirection, .leftToRight)
                .typesettingLanguage(Locale.Language(identifier: Interface.language))
        }
    }
}
