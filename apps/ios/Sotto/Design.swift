import SwiftUI
import SottoCore
import UIKit

// The iPhone's Glow look (ADR-0051): one type scale and one spacing scale in Figtree, colour from the chosen
// theme, a wash at the top of each page, glass over content, and glows that say what needs the user and
// what is working. `docs/prototypes/iphone-redesign/glow-refined.html`, on the
// `prototype/iphone-glow-redesign` branch, is the reference for every value here.

// MARK: - Theme

private struct ThemeIDKey: EnvironmentKey {
    /// Read from this iPhone's preferences when nothing above has set it, so a sheet still paints the theme.
    static var defaultValue: String { PhonePreferences().themeID }
}

private struct DensityKey: EnvironmentKey {
    static var defaultValue: PhoneDensity { PhonePreferences().density }
}

extension EnvironmentValues {
    /// The chosen palette's id. Set once at the root from the stored preference.
    var sottoThemeID: String {
        get { self[ThemeIDKey.self] }
        set { self[ThemeIDKey.self] = newValue }
    }
    /// Comfortable or compact, for the spacing that density changes.
    var sottoDensity: PhoneDensity {
        get { self[DensityKey.self] }
        set { self[DensityKey.self] = newValue }
    }
    /// The chosen palette in the appearance in effect here. Read it with `@Environment(\.sottoTheme)` where a
    /// view needs a `Color` (gradients, shadows); everywhere else, `Palette` roles resolve it themselves.
    var sottoTheme: ThemeSwatch { ThemePalettes.named(sottoThemeID).swatch(dark: colorScheme == .dark) }
}

extension ThemePalettes {
    static let defaultID = "sotto"
    /// A built-in palette by id; an id this build does not know reads as Sotto.
    static func named(_ id: String) -> ThemePalette { all.first { $0.id == id } ?? sotto }
}

extension ThemePalette {
    func swatch(dark: Bool) -> ThemeSwatch { dark ? self.dark : self.light }
    /// A colour that follows light and dark by itself, for places outside the environment such as the root tint.
    func adaptive(_ role: ThemeRoleName) -> Color {
        let lightColor = self.light.rgb(role)
        let darkColor = self.dark.rgb(role)
        return Color(uiColor: UIColor { traits in
            let chosen = traits.userInterfaceStyle == .dark ? darkColor : lightColor
            return UIColor(red: chosen.red, green: chosen.green, blue: chosen.blue, alpha: 1)
        })
    }
}

extension ThemeRGB {
    var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: 1) }
    /// This colour with `amount` of another laid over it, as a translucent tint composites.
    func mixed(with other: ThemeRGB, _ amount: Double) -> ThemeRGB {
        ThemeRGB(red + (other.red - red) * amount, green + (other.green - green) * amount, blue + (other.blue - blue) * amount)
    }
}

/// How strongly surfaces are tinted. `tests/unit/shared/iosPalettes.test.ts` checks text contrast against these
/// same amounts; change them together.
enum Tint {
    static let needsYou = 0.11
    static let working = 0.09
    static let answered = 0.14
    static let chosen = 0.2
    static let accentPill = 0.13
    static let failed = 0.1
    static let dangerButton = 0.13
    static let online = 0.07
}

/// Every colour a view can ask a theme for. The first group are the palette's own roles; the text roles keep
/// 4.5:1 on the surfaces they sit on; the last group are translucent washes of the text colour.
enum ThemeRoleName: Sendable {
    case canvas, surface, raised, overlay, border
    case ink, muted, placeholder
    case accent, onAccent, accentSurface, accentText
    case warning, warningSurface, warningText
    case danger, dangerSurface, dangerText
    case bubble, bubbleInk, code, codeInk
    case hairline, fillSoft, fillSofter
}

extension ThemeSwatch {
    /// The opaque colour for a role. The translucent roles answer with the text colour they are made from.
    func rgb(_ role: ThemeRoleName) -> ThemeRGB {
        switch role {
        case .canvas: return canvas
        case .surface: return surface
        case .raised: return surfaceRaised
        case .overlay: return surfaceOverlay
        case .border: return border
        case .ink, .hairline, .fillSoft, .fillSofter: return text
        case .muted: return mutedText
        case .placeholder: return placeholder
        case .accent: return accent
        case .onAccent: return accentForeground
        case .accentSurface: return accentSurface
        case .accentText: return accentText
        case .warning: return warning
        case .warningSurface: return warningSurface
        case .warningText: return warningText
        case .danger: return error
        case .dangerSurface: return errorSurface
        case .dangerText: return dangerText
        case .bubble: return messageSurface
        case .bubbleInk: return messageForeground
        case .code: return codeBackground
        case .codeInk: return codeForeground
        }
    }
    func color(_ role: ThemeRoleName) -> Color {
        switch role {
        case .hairline: return text.color.opacity(0.1)
        case .fillSoft: return text.color.opacity(0.07)
        case .fillSofter: return text.color.opacity(0.045)
        default: return rgb(role).color
        }
    }
    /// A surface with a role laid over it, solid. Cards tinted this way keep their text readable (see `Tint`).
    func tinted(_ base: ThemeRoleName, with role: ThemeRoleName, _ amount: Double) -> Color {
        rgb(base).mixed(with: rgb(role), amount).color
    }
}

/// A theme role as a shape style: it resolves against the theme and appearance where it is drawn, so changing
/// either repaints every view that uses it.
struct ThemeRole: ShapeStyle {
    let name: ThemeRoleName
    let amount: Double
    init(_ name: ThemeRoleName, amount: Double = 1) {
        self.name = name
        self.amount = amount
    }
    func resolve(in environment: EnvironmentValues) -> Color {
        let color = environment.sottoTheme.color(name)
        return amount == 1 ? color : color.opacity(amount)
    }
    /// The same role, more translucent. Stays a `ThemeRole`, so it mixes with other roles in a conditional.
    func opacity(_ value: Double) -> ThemeRole { ThemeRole(name, amount: amount * value) }
    /// Nothing at all, for the other side of a conditional.
    static let clear = ThemeRole(.canvas, amount: 0)
}

/// The theme's roles under the names the views use. The first group are the names the app used before the Glow
/// look; they keep working and map onto the theme.
enum Palette {
    static let canvas = ThemeRole(.canvas)
    static let surface = ThemeRole(.surface)
    static let raised = ThemeRole(.raised)
    static let ink = ThemeRole(.ink)
    static let muted = ThemeRole(.muted)
    static let border = ThemeRole(.border)
    static let hairline = ThemeRole(.hairline)
    static let accent = ThemeRole(.accent)
    static let bubble = ThemeRole(.bubble)
    static let bubbleInk = ThemeRole(.bubbleInk)
    static let warning = ThemeRole(.warning)
    static let danger = ThemeRole(.danger)

    static let placeholder = ThemeRole(.placeholder)
    static let onAccent = ThemeRole(.onAccent)
    static let accentText = ThemeRole(.accentText)
    static let warningText = ThemeRole(.warningText)
    static let dangerText = ThemeRole(.dangerText)
    static let code = ThemeRole(.code)
    static let codeInk = ThemeRole(.codeInk)
    static let fillSoft = ThemeRole(.fillSoft)
    static let fillSofter = ThemeRole(.fillSofter)
}

// MARK: - Type, spacing and radii

/// The type scale. Sizes follow their text style, so Dynamic Type and the text-size step scale them together.
enum TextScale {
    case caption, small, body, lead, title, display
    var size: CGFloat {
        switch self {
        case .caption: return 12
        case .small: return 13.5
        case .body: return 15.5
        case .lead: return 17
        case .title: return 21
        case .display: return 28
        }
    }
    var style: Font.TextStyle {
        switch self {
        case .caption: return .caption
        case .small: return .footnote
        case .body: return .body
        case .lead: return .body
        case .title: return .title3
        case .display: return .title
        }
    }
}

extension Font {
    /// Figtree at a step of the type scale.
    static func sotto(_ scale: TextScale, _ weight: Font.Weight = .regular) -> Font {
        .figtree(scale.size, scale.style, weight)
    }
    static func figtree(_ size: CGFloat, _ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        let face: String
        switch weight {
        case .bold, .heavy, .black: face = "Figtree-Bold"
        case .semibold, .medium: face = "Figtree-SemiBold"
        default: face = "Figtree-Regular"
        }
        return .custom(face, size: size, relativeTo: style)
    }
    static let mono = Font.system(.subheadline, design: .monospaced)
}

/// The spacing scale.
enum Space {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s7: CGFloat = 32
    static let s8: CGFloat = 44
    /// A page's side margin.
    static let gutter: CGFloat = 20
    /// Spacing that density tightens: rows, messages, lists and steps.
    static func dense(_ value: CGFloat, _ density: PhoneDensity) -> CGFloat { value * density.factor }
}

enum Radius {
    static let sm: CGFloat = 10
    static let md: CGFloat = 14
    static let lg: CGFloat = 20
    static let xl: CGFloat = 28
}

extension PhoneDensity {
    var factor: CGFloat { self == .compact ? 0.62 : 1 }
}

extension PhoneAppearance {
    /// Nil follows the iPhone.
    var scheme: ColorScheme? {
        switch self {
        case .dark: return .dark
        case .light: return .light
        case .system: return nil
        }
    }
}

extension PhoneTextSize {
    /// The smallest size a step gives, whatever the iPhone's own size. Larger keeps what the earlier Larger text switch
    /// gave (at least extra extra extra large), and the steps stay in order at every system size.
    private var least: DynamicTypeSize? {
        switch self {
        case .large: return .xLarge
        case .larger: return .xxxLarge
        case .largest: return .accessibility1
        case .smaller, .standard: return nil
        }
    }
    /// The iPhone's own size moved by this step. Smaller never shrinks an accessibility size iOS asks for.
    func applied(to system: DynamicTypeSize) -> DynamicTypeSize {
        let sizes = DynamicTypeSize.allCases
        guard let index = sizes.firstIndex(of: system) else { return system }
        if offset < 0 && system.isAccessibilitySize { return system }
        var target = min(max(index + offset, 0), sizes.count - 1)
        if let least, let floor = sizes.firstIndex(of: least) { target = max(target, floor) }
        return sizes[target]
    }
}

/// Applies this iPhone's display preferences to everything under it: theme, appearance, text size and density.
/// Nothing here changes a computer's settings.
struct PhoneDisplayPreferences: ViewModifier {
    @AppStorage(PhonePreferenceKey.theme) private var themeID = ThemePalettes.defaultID
    @AppStorage(PhonePreferenceKey.appearance) private var appearance = PhoneAppearance.dark.rawValue
    @AppStorage(PhonePreferenceKey.textSize) private var textSize = ""
    @AppStorage(PhonePreferenceKey.legacyLargerText) private var legacyLarger = false
    @AppStorage(PhonePreferenceKey.density) private var density = PhoneDensity.comfortable.rawValue
    @Environment(\.dynamicTypeSize) private var systemSize
    func body(content: Content) -> some View {
        let palette = ThemePalettes.named(themeID)
        let size = PhoneTextSize.resolve(textSize, legacyLarger: legacyLarger)
        return content
            .environment(\.sottoThemeID, palette.id)
            .environment(\.sottoDensity, PhoneDensity(rawValue: density) ?? .comfortable)
            .tint(palette.adaptive(.accent))
            .preferredColorScheme((PhoneAppearance(rawValue: appearance) ?? .dark).scheme)
            .dynamicTypeSize(size.applied(to: systemSize))
    }
}

// MARK: - Lights

/// A small status light with a soft halo. Accent for working or online, warning for needs you, danger for
/// failed or unreachable, an empty ring for quiet. A breathing light slows to still under Reduce Motion.
struct Light: View {
    enum Tone { case accent, warning, danger, off }
    let tone: Tone
    var size: CGFloat = 8
    var breathing = false
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false
    var body: some View {
        Group {
            if tone == .off {
                Circle().strokeBorder(theme.color(.muted), lineWidth: 1.5)
            } else {
                // A gradient halo rather than a shadow: it costs nothing to move or fade.
                Circle().fill(color)
                    .background(
                        Circle()
                            .fill(RadialGradient(colors: [color.opacity(0.55), color.opacity(0)], center: .center,
                                                 startRadius: size * 0.3, endRadius: size * 1.4))
                            .frame(width: size * 2.8, height: size * 2.8)
                    )
            }
        }
        .frame(width: size, height: size)
        .scaleEffect(moving && dim ? 0.88 : 1)
        .opacity(moving && dim ? 0.55 : 1)
        .animation(moving ? .easeInOut(duration: 1.3).repeatForever(autoreverses: true) : nil, value: dim)
        .onAppear { dim = moving }
        .onChange(of: moving) { _, now in dim = now }
        .accessibilityHidden(true)
    }
    private var moving: Bool { breathing && !reduceMotion && tone != .off }
    private var color: Color {
        switch tone {
        case .accent: return theme.color(.accent)
        case .warning: return theme.color(.warning)
        case .danger: return theme.color(.danger)
        case .off: return theme.color(.muted)
        }
    }
}

/// A thread's state as a light: warm when it needs you, breathing accent while it works, danger when it failed.
struct StatusDot: View {
    let state: ThreadState
    var size: CGFloat = 8
    var body: some View { Light(tone: tone, size: size, breathing: state.workInProgress) }
    private var tone: Light.Tone {
        switch state {
        case .needsAnswer, .asked: return .warning
        case .working, .waiting, .compacting: return .accent
        case .failed: return .danger
        case .done: return .off
        }
    }
}

/// Whether a computer can be reached: accent when online, danger when it can't be, an empty ring while connecting.
struct ComputerDot: View {
    let status: ComputerStatus
    var size: CGFloat = 8
    var body: some View { Light(tone: tone, size: size) }
    private var tone: Light.Tone {
        switch status {
        case .online: return .accent
        case .unreachable: return .danger
        case .connecting: return .off
        }
    }
}

// MARK: - Elapsed time

enum Elapsed {
    /// "8s", "4m 07s", "1h 03m".
    static func words(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600
        let minutes = (total / 60) % 60
        let rest = total % 60
        if hours > 0 { return "\(hours)h \(twoDigits(minutes))m" }
        if minutes > 0 { return "\(minutes)m \(twoDigits(rest))s" }
        return "\(rest)s"
    }
    private static func twoDigits(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
}

/// Time since a moment, ticking each second.
struct ElapsedText: View {
    let since: Date
    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { context in
            Text(Elapsed.words(context.date.timeIntervalSince(since)))
        }
    }
}

// MARK: - Wash

/// The light at the top of a page, mixed from the theme's accent into the canvas. It warms while anything needs
/// the user and drifts slowly; under Reduce Motion it holds still.
struct Wash: View {
    enum Tone { case normal, quiet, failed }
    var warm = false
    var tone: Tone = .normal
    var height: CGFloat = 520
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drifting = false
    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let tall = proxy.size.height
            ZStack(alignment: .topLeading) {
                WashBlob(color: primary, center: CGPoint(x: width * 0.116, y: 0), radii: CGSize(width: width * 0.72, height: tall * 0.52), fade: 0.72)
                WashBlob(color: secondary, center: CGPoint(x: width * 0.956, y: tall * 0.06), radii: CGSize(width: width * 0.576, height: tall * 0.44), fade: 0.72)
                WashBlob(color: warmth, center: CGPoint(x: width * 0.932, y: tall * 0.02), radii: CGSize(width: width * 0.552, height: tall * 0.40), fade: 0.70)
                    .opacity(warm ? 1 : 0)
                    .animation(.easeInOut(duration: 1.6), value: warm)
            }
            .frame(width: width, height: tall, alignment: .topLeading)
            // Flattened into one image so the drift moves a picture instead of redrawing three gradients every frame.
            .drawingGroup()
            .scaleEffect(drifting ? 1.07 : 1, anchor: .top)
            .offset(x: drifting ? -width * 0.03 : 0, y: drifting ? tall * 0.02 : 0)
            .animation(drifting ? .easeInOut(duration: 26).repeatForever(autoreverses: true) : .default, value: drifting)
        }
        .frame(height: height)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { drifting = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in drifting = !reduced }
    }
    private var dark: Bool { scheme == .dark }
    private var primary: Color {
        switch tone {
        case .normal: return theme.color(.accent).opacity(dark ? 0.34 : 0.22)
        case .quiet: return theme.color(.accent).opacity(0.16)
        case .failed: return theme.color(.danger).opacity(0.16)
        }
    }
    private var secondary: Color {
        theme.color(.accent).opacity(tone == .normal ? (dark ? 0.16 : 0.11) : 0.08)
    }
    private var warmth: Color { theme.color(.warning).opacity(dark ? 0.22 : 0.2) }
}

/// One soft ellipse of the wash, fading out at `fade` of its radii.
private struct WashBlob: View {
    let color: Color
    let center: CGPoint
    let radii: CGSize
    let fade: CGFloat
    var body: some View {
        EllipticalGradient(gradient: Gradient(stops: [
            Gradient.Stop(color: color, location: 0),
            Gradient.Stop(color: color.opacity(0), location: fade)
        ]), center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
            .frame(width: radii.width * 2, height: radii.height * 2)
            .position(x: center.x, y: center.y)
    }
}

// MARK: - A tab page that scrolls as one sheet

/// A tab's page: the wash, the heading, its controls and the content all scroll together as one sheet, with no
/// compact bar. Once the page moves, content fades out under the status bar so text never meets the clock.
/// Apply `.refreshable` and `.scrollDismissesKeyboard` to the page; the scroll view inside reads them.
struct SheetPage<Content: View>: View {
    var warm = false
    var washTone: Wash.Tone = .normal
    var washHeight: CGFloat = 520
    let content: Content
    @State private var fade: CGFloat = 0
    init(warm: Bool = false, washTone: Wash.Tone = .normal, washHeight: CGFloat = 520, @ViewBuilder content: () -> Content) {
        self.warm = warm
        self.washTone = washTone
        self.washHeight = washHeight
        self.content = content()
    }
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    content
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.s8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(alignment: .top) {
                    // Reaches up under the status bar, so at rest the wash meets the top edge.
                    Wash(warm: warm, tone: washTone, height: washHeight + 160).offset(y: -160)
                }
                .background(alignment: .top) {
                    // How far the content has moved up from rest, read against the page's own top.
                    GeometryReader { proxy in
                        Color.clear.onChange(of: proxy.frame(in: .named("sheet-page")).minY) { _, top in travelled(top) }
                    }
                    .frame(height: 0)
                }
            }
        }
        .coordinateSpace(.named("sheet-page"))
        .background(Palette.canvas)
        .overlay(alignment: .top) { StatusBarFade().opacity(fade) }
    }
    /// The fade comes in over the first 24 points of travel and is clear at rest.
    private func travelled(_ top: CGFloat) {
        let next = min(1, max(0, -top / 24))
        if next != fade { fade = next }
    }
}

/// The canvas fading in under the status bar.
private struct StatusBarFade: View {
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        GeometryReader { proxy in
            LinearGradient(stops: [
                Gradient.Stop(color: theme.canvas.color, location: 0.62),
                Gradient.Stop(color: theme.canvas.color.opacity(0), location: 1)
            ], startPoint: .top, endPoint: .bottom)
                .frame(height: proxy.safeAreaInsets.top + 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A page's big title, with an optional line under it and a control at the trailing edge.
struct PageHeading<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    let trailing: Trailing
    init(_ title: String, subtitle: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(alignment: .center, spacing: Space.s3) {
                Text(title).font(.sotto(.display, .bold)).tracking(-0.6).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.s2)
                trailing
            }
            .frame(minHeight: 52)
            if let subtitle {
                Text(subtitle).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

extension PageHeading where Trailing == EmptyView {
    init(_ title: String, subtitle: String? = nil) {
        self.init(title, subtitle: subtitle) { EmptyView() }
    }
}

// MARK: - Glass

/// Frosted glass: a material with a translucent tint of the surface and a hairline highlight. Under Reduce
/// Transparency it is a solid surface.
struct GlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var strong = false
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    shape.fill(theme.color(strong ? .overlay : .surface))
                } else {
                    shape.fill(.ultraThinMaterial)
                        .overlay(shape.fill(theme.color(strong ? .overlay : .surface).opacity(tintAmount)))
                }
            }
            .overlay(shape.strokeBorder(theme.color(.hairline), lineWidth: 1))
            .overlay(shape.strokeBorder(LinearGradient(colors: [highlight, highlight.opacity(0)], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.3)), lineWidth: 1))
    }
    private var tintAmount: Double {
        if strong { return scheme == .dark ? 0.76 : 0.8 }
        return scheme == .dark ? 0.58 : 0.68
    }
    private var highlight: Color {
        scheme == .dark ? theme.color(.ink).opacity(0.1) : theme.color(.surface).opacity(0.95)
    }
}

extension View {
    /// Frosted glass in a shape; `strong` for menus and toasts that float over busy content.
    func glass<S: InsettableShape>(in shape: S, strong: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, strong: strong))
    }
}

// MARK: - Cards and glows

/// How a card is lit. Needs you carries a warm glow, working a breathing accent halo, answered an accent glow.
enum CardTone { case plain, needsYou, answered, working, online }

/// A card's surface: radius 20, a hairline, a highlight along the top edge, and the glow its tone carries.
struct CardSurface: ViewModifier {
    let tone: CardTone
    var radius: CGFloat = Radius.lg
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .background {
                shape.fill(LinearGradient(stops: [
                    Gradient.Stop(color: top, location: 0),
                    Gradient.Stop(color: theme.color(.surface), location: 0.72)
                ], startPoint: .top, endPoint: .bottom))
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(ring, lineWidth: 1))
            .overlay(shape.strokeBorder(LinearGradient(colors: [highlight, highlight.opacity(0)], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.2)), lineWidth: 1))
            .background { glow(shape) }
    }
    @ViewBuilder private func glow(_ shape: RoundedRectangle) -> some View {
        switch tone {
        case .needsYou: GlowLayer(shape: shape, color: theme.color(.warning).opacity(0.5), base: theme.color(.surface), period: 6)
        case .working: GlowLayer(shape: shape, color: theme.color(.accent).opacity(0.5), base: theme.color(.surface), period: 4.4)
        case .answered: GlowLayer(shape: shape, color: theme.color(.accent).opacity(0.6), base: theme.color(.surface), period: nil)
        case .plain, .online: EmptyView()
        }
    }
    private var top: Color {
        switch tone {
        case .plain: return theme.color(.surface)
        case .needsYou: return theme.tinted(.surface, with: .warning, Tint.needsYou)
        case .answered: return theme.tinted(.surface, with: .accent, Tint.answered)
        case .working: return theme.tinted(.surface, with: .accent, Tint.working)
        case .online: return theme.tinted(.surface, with: .accent, Tint.online)
        }
    }
    private var ring: Color {
        switch tone {
        case .plain, .online: return theme.color(.hairline)
        case .needsYou: return theme.color(.warning).opacity(0.3)
        case .answered: return theme.color(.accent).opacity(0.45)
        case .working: return theme.color(.accent).opacity(0.26)
        }
    }
    private var highlight: Color {
        scheme == .dark ? theme.color(.ink).opacity(0.1) : theme.color(.surface).opacity(0.95)
    }
}

/// A soft shadow drawn once: a blurred copy of the shape, flattened into an image and laid behind the view. SwiftUI's
/// `.shadow` redraws its blur whenever the view moves or anything in it changes, which in a scrolling page is every
/// frame, and it does so even for a clear colour; this costs a composite instead, and nothing at all when not showing.
struct SoftShadow<S: Shape>: View {
    let shape: S
    let color: Color
    let radius: CGFloat
    var y: CGFloat = 0
    var body: some View {
        let room = radius * 2 + abs(y)
        shape.fill(color)
            .padding(room)
            .blur(radius: radius)
            .offset(y: y)
            .drawingGroup()
            .padding(-room)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

extension View {
    /// `.shadow` without its per-frame cost; see `SoftShadow`. `showing` false draws nothing.
    func softShadow<S: Shape>(_ shape: S, color: Color, radius: CGFloat, y: CGFloat = 0, showing: Bool = true) -> some View {
        background {
            if showing { SoftShadow(shape: shape, color: color, radius: radius, y: y) }
        }
    }
}

/// The light behind a card, breathing slowly when it has a period. Still under Reduce Motion.
private struct GlowLayer: View {
    let shape: RoundedRectangle
    let color: Color
    let base: Color
    let period: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bright = false
    var body: some View {
        shape.fill(base)
            .softShadow(shape, color: color, radius: 18, y: 10)
            .opacity(level)
            .animation(breathing ? .easeInOut(duration: (period ?? 4) / 2).repeatForever(autoreverses: true) : nil, value: bright)
            .onAppear { bright = breathing }
            .onChange(of: breathing) { _, now in bright = now }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
    private var breathing: Bool { period != nil && !reduceMotion }
    private var level: Double {
        if period == nil { return 1 }
        if reduceMotion { return 0.8 }
        return bright ? 1 : 0.55
    }
}

/// A faint danger edge for something that failed or can't be reached: a short bar at the leading edge and a
/// tint that fades across.
struct FailedEdge: ViewModifier {
    @Environment(\.sottoTheme) private var theme
    var active = true
    var tint: Double = Tint.failed
    func body(content: Content) -> some View {
        content
            .background {
                if active {
                    LinearGradient(colors: [theme.color(.danger).opacity(tint), theme.color(.danger).opacity(0)], startPoint: .leading, endPoint: UnitPoint(x: 0.55, y: 0.5))
                }
            }
            .overlay(alignment: .leading) {
                if active {
                    UnevenRoundedRectangle(bottomTrailingRadius: 3, topTrailingRadius: 3)
                        .fill(theme.color(.danger))
                        .frame(width: 3)
                        .padding(.vertical, 10)
                        .softShadow(Rectangle(), color: theme.color(.danger), radius: 7)
                        .opacity(0.8)
                        .accessibilityHidden(true)
                }
            }
    }
}

extension View {
    /// A card's surface and glow. Pad the content first.
    func sottoCard(_ tone: CardTone = .plain, radius: CGFloat = Radius.lg) -> some View {
        modifier(CardSurface(tone: tone, radius: radius))
    }
    func failedEdge(_ active: Bool = true, tint: Double = Tint.failed) -> some View { modifier(FailedEdge(active: active, tint: tint)) }
}

/// The light that runs along the bottom of a working card. Absent under Reduce Motion.
struct Runner: View {
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var running = false
    var body: some View {
        GeometryReader { proxy in
            LinearGradient(colors: [theme.color(.accent).opacity(0), theme.color(.accent).opacity(0.9), theme.color(.accent).opacity(0)],
                           startPoint: .leading, endPoint: .trailing)
                .frame(width: proxy.size.width * 0.4, height: 2)
                .offset(x: running ? proxy.size.width : -proxy.size.width * 0.4)
                .animation(running ? .easeInOut(duration: 2.8).repeatForever(autoreverses: false) : nil, value: running)
        }
        .frame(height: 2)
        .clipped()
        .opacity(reduceMotion ? 0 : 1)
        .onAppear { running = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in running = !reduced }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Headings

/// A section's heading: an optional light, the name and how many it holds.
struct SectionHeading: View {
    let title: String
    var count: Int? = nil
    var light: Light.Tone? = nil
    init(_ title: String, count: Int? = nil, light: Light.Tone? = nil) {
        self.title = title
        self.count = count
        self.light = light
    }
    var body: some View {
        HStack(spacing: Space.s2) {
            if let light { Light(tone: light) }
            Text(title).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
            if let count { Text("\(count)").font(.sotto(.small)).foregroundStyle(Palette.muted) }
        }
        .padding(.top, Space.s7)
        .padding(.bottom, Space.s3)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A group's quiet heading, as on Settings.
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            .padding(.horizontal, Space.s1).padding(.top, Space.s7).padding(.bottom, Space.s2)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Buttons

/// Press feedback: a slight shrink, or a dim under Reduce Motion.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PressBody(configuration: configuration)
    }
}

private struct PressBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.972 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// The capsule buttons. Primary is the one accent action on a surface; soft and ghost are the others; danger
/// removes or stops something.
enum PillKind { case primary, soft, ghost, danger }

struct PillButtonStyle: ButtonStyle {
    var kind: PillKind = .soft
    var wide = false
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        PillBody(label: configuration.label, pressed: configuration.isPressed, kind: kind, wide: wide, compact: compact)
    }
}

private struct PillBody: View {
    let label: ButtonStyleConfiguration.Label
    let pressed: Bool
    let kind: PillKind
    let wide: Bool
    let compact: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        label
            .font(.sotto(compact ? .small : .body, .semibold))
            .multilineTextAlignment(.center)
            .padding(.horizontal, compact ? Space.s3 : Space.s4)
            .padding(.vertical, Space.s2)
            .frame(maxWidth: wide ? .infinity : nil, minHeight: compact ? 40 : 44)
            .foregroundStyle(foreground)
            .background(fill, in: Capsule())
            .softShadow(Capsule(), color: theme.color(.accent).opacity(0.4), radius: 10, y: 6, showing: kind == .primary && enabled)
            .contentShape(Capsule())
            .opacity(enabled ? 1 : 0.42)
            .scaleEffect(pressed && !reduceMotion ? 0.972 : 1)
            .opacity(pressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: 0.16), value: pressed)
    }
    private var foreground: ThemeRole {
        switch kind {
        case .primary: return Palette.onAccent
        case .soft: return Palette.ink
        case .ghost: return Palette.accentText
        case .danger: return Palette.dangerText
        }
    }
    private var fill: ThemeRole {
        switch kind {
        case .primary: return Palette.accent
        case .soft: return Palette.fillSoft
        case .ghost: return ThemeRole.clear
        case .danger: return Palette.danger.opacity(Tint.dangerButton)
        }
    }
}

/// The one accent action on a surface.
struct ActionStyle: ButtonStyle {
    var wide = false
    func makeBody(configuration: Configuration) -> some View {
        PillBody(label: configuration.label, pressed: configuration.isPressed, kind: .primary, wide: wide, compact: false)
    }
}

/// Every other action: the same shape on a soft fill.
struct PlainStyle: ButtonStyle {
    var wide = false, compact = false
    func makeBody(configuration: Configuration) -> some View {
        PillBody(label: configuration.label, pressed: configuration.isPressed, kind: .soft, wide: wide, compact: compact)
    }
}

/// A choice in a question: left-aligned, with its explanation under it, ringed in the accent once chosen.
struct ChoiceStyle: ButtonStyle {
    var chosen = false
    func makeBody(configuration: Configuration) -> some View {
        ChoiceBody(label: configuration.label, pressed: configuration.isPressed, chosen: chosen)
    }
}

private struct ChoiceBody: View {
    let label: ButtonStyleConfiguration.Label
    let pressed: Bool
    let chosen: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return label
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
            .foregroundStyle(Palette.ink)
            .background(shape.fill(chosen ? theme.color(.accent).opacity(0.12) : theme.color(.fillSofter)))
            .overlay(shape.strokeBorder(chosen ? theme.color(.accent).opacity(0.8) : theme.color(.hairline), lineWidth: chosen ? 1.5 : 1))
            .softShadow(shape, color: theme.color(.accent).opacity(0.35), radius: 10, showing: chosen)
            .contentShape(shape)
            .opacity(!enabled ? 0.5 : 1)
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .opacity(pressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: 0.16), value: pressed)
    }
}

/// A chip: a short choice in a capsule, glowing in the accent once chosen.
struct ChipStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        ChipBody(label: configuration.label, pressed: configuration.isPressed, selected: selected)
    }
}

private struct ChipBody: View {
    let label: ButtonStyleConfiguration.Label
    let pressed: Bool
    let selected: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        label
            .font(.sotto(.small, .semibold))
            .lineLimit(2)
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.s2)
            .frame(minHeight: 44)
            .foregroundStyle(Palette.ink)
            .background(Capsule().fill(selected ? theme.tinted(.surface, with: .accent, Tint.chosen) : theme.color(.fillSoft)))
            .overlay(Capsule().strokeBorder(selected ? theme.color(.accent) : theme.color(.hairline), lineWidth: selected ? 1.5 : 1))
            .softShadow(Capsule(), color: theme.color(.accent).opacity(0.45), radius: 9, showing: selected)
            .contentShape(Capsule())
            .opacity(enabled ? 1 : 0.5)
            .scaleEffect(pressed && !reduceMotion ? 0.972 : 1)
            .opacity(pressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: 0.16), value: pressed)
            .animation(.easeInOut(duration: 0.25), value: selected)
    }
}

/// The round glass button at the trailing edge of a page's heading, such as New thread.
struct GlassCircleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        GlassCircleBody(label: configuration.label, pressed: configuration.isPressed)
    }
}

private struct GlassCircleBody: View {
    let label: ButtonStyleConfiguration.Label
    let pressed: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        label
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(Palette.accentText)
            .frame(width: 44, height: 44)
            .glass(in: Circle())
            .overlay(Circle().strokeBorder(theme.color(.accent).opacity(0.28), lineWidth: 1))
            .softShadow(Circle(), color: theme.color(.accent).opacity(0.45), radius: 12, y: 6)
            .contentShape(Circle())
            .opacity(enabled ? 1 : 0.42)
            .scaleEffect(pressed && !reduceMotion ? 0.94 : 1)
            .opacity(pressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: 0.16), value: pressed)
    }
}

// MARK: - Layout

/// Lays its children out in rows, wrapping to the next row when one is full. For chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = Space.s2
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
            if x > 0 && x + size.width > width {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Toast

/// A short confirmation that drops in under the status bar and leaves on its own after a moment.
struct Toast: View {
    let text: String
    var body: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                .foregroundStyle(Palette.onAccent)
                .frame(width: 24, height: 24)
                .background(Palette.accent, in: Circle())
                .accessibilityHidden(true)
            Text(text).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink).lineLimit(2)
        }
        .padding(.leading, Space.s3).padding(.trailing, 18).padding(.vertical, 10)
        .glass(in: Capsule(), strong: true)
        .softShadow(Capsule(), color: Color.black.opacity(0.3), radius: 20, y: 12)
        .padding(.horizontal, Space.s4)
        .accessibilityElement(children: .combine)
    }
}

private struct ToastPresenter: ViewModifier {
    @Binding var message: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let shown = message {
                    Toast(text: shown)
                        .padding(.top, Space.s1)
                        .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                        .task(id: shown) {
                            UIAccessibility.post(notification: .announcement, argument: shown)
                            try? await Task.sleep(nanoseconds: 2_600_000_000)
                            if message == shown { message = nil }
                        }
                }
            }
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.82), value: message)
    }
}

extension View {
    /// Shows `message` as a toast until it leaves on its own, then sets it back to nil.
    func toast(_ message: Binding<String?>) -> some View { modifier(ToastPresenter(message: message)) }
}

// MARK: - Fields, boxes and banners

extension View {
    /// A tab's pushed page: the canvas behind it and a title.
    func page(_ title: String) -> some View {
        background(Palette.canvas).navigationTitle(title)
            .toolbarBackground(Palette.canvas, for: .navigationBar)
    }
    /// A text field's box.
    func fieldSurface() -> some View {
        padding(Space.s3).frame(minHeight: 48)
            .background(Palette.fillSofter, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
    }
    /// A padded card on the surface.
    func card() -> some View {
        padding(Space.s4).frame(maxWidth: .infinity, alignment: .leading).sottoCard(.plain)
    }
}
