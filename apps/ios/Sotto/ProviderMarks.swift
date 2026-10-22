import SwiftUI
import SottoCore

/// A provider's logo, from the desktop's own marks (`src/renderer/src/agents/ProviderMark.tsx`), as vectors in the
/// asset catalog. It takes the colour of the words beside it, as every glyph in the Glow look does, and is as tall as
/// they are. A provider the phone doesn't know draws nothing: never a guessed logo. Decorative: the words name it.
struct ProviderLogo: View {
    let providerID: String?
    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13
    var body: some View {
        if let name = Self.asset(providerID) {
            Image(name)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
    /// The logo's name in the asset catalog, for each provider that has one.
    static func asset(_ providerID: String?) -> String? {
        ["codex": "ProviderCodex", "claude": "ProviderClaude", "grok": "ProviderGrok", "devin": "ProviderDevin", "muse": "ProviderMuse", "opencode": "ProviderOpenCode"][providerID ?? ""]
    }
}

/// Watcher's owl, simplified for small sizes as the desktop draws it (`WatcherOwl.tsx`), in the colour of what holds it.
struct WatcherOwlMark: View {
    var size: CGFloat = 13
    var body: some View {
        Image("WatcherOwl")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

/// The quiet owl right after a watched thread's provider logo: an image that says "Watched by Watcher", never a control.
struct WatchedOwl: View {
    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13
    var body: some View {
        WatcherOwlMark(size: size)
            .accessibilityLabel(WatchedWords.label)
    }
}

/// The marks before a "Codex on Laptop" line (3B): the provider's logo, then the owl on a watched thread.
struct ProviderMarks: View {
    let providerID: String?
    let watched: Bool
    var body: some View {
        if ProviderLogo.asset(providerID) != nil || watched {
            HStack(spacing: 4) {
                ProviderLogo(providerID: providerID)
                if watched { WatchedOwl() }
            }
        }
    }
}

/// A line that says where a thread runs, with its provider's marks before it.
struct PlaceLine: View {
    let providerID: String?
    let watched: Bool
    let text: String
    var tone: ThemeRole = Palette.muted
    var body: some View {
        HStack(spacing: 5) {
            ProviderMarks(providerID: providerID, watched: watched)
            Text(text).lineLimit(1)
        }
        .font(.sotto(.small))
        .foregroundStyle(tone)
    }
}
