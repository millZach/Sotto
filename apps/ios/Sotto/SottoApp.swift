import SwiftUI

@main struct SottoApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var previews = PhotoPreviews()
    @Environment(\.scenePhase) private var phase
    init() {
        // The earlier Larger text switch becomes the Larger step of the five text sizes (ADR-0050).
        PhonePreferences().migrate()
    }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(previews)
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
                    model.phase(phase)
                }
                .onChange(of: phase) { _, value in model.phase(value) }
                .modifier(PhoneDisplayPreferences())
        }
    }
}
