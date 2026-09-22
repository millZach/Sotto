import SwiftUI

@main struct SottoApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
                .font(.custom("Figtree-Regular", size: 17, relativeTo: .body))
                .foregroundStyle(Color("Ink")).tint(Color("Accent"))
                .overlay {
                    if phase != .active {
                        Color("Canvas").ignoresSafeArea().overlay(Text("Sotto").font(.title2).foregroundStyle(Color("Ink")))
                    }
                }
                .task { model.phase(phase) }
                .onChange(of: phase) { _, value in model.phase(value) }
        }
    }
}
