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
    /// The same colour for Core Animation, at `alpha`.
    func uiColor(_ alpha: CGFloat) -> UIColor {
        UIColor(red: CGFloat(red), green: CGFloat(green), blue: CGFloat(blue), alpha: alpha)
    }
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
    var body: some View {
        Group {
            if tone == .off {
                Circle().strokeBorder(theme.color(.muted), lineWidth: 1.5)
            } else if moving {
                // The same dot and halo drawn by Core Animation, which breathes it without the app's help.
                BreathingLight(color: theme.rgb(role))
                    .allowsHitTesting(false)
            } else {
                // A gradient halo rather than a shadow: it costs nothing to move or fade.
                Circle().fill(color)
                    .background(
                        Circle()
                            .fill(RadialGradient(colors: [color.opacity(Light.haloStrength), color.opacity(0)], center: .center,
                                                 startRadius: size * 0.3, endRadius: Light.haloRadius(size)))
                            .frame(width: Light.haloRadius(size) * 2, height: Light.haloRadius(size) * 2)
                    )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
    private var moving: Bool { breathing && !reduceMotion && tone != .off && !DebugFlags.still }
    /// The halo reaches as far past the dot as the shadow it replaced did (about 13 points, whatever the dot's size),
    /// starting a little softer than the dot so the core stays the dot itself.
    static let haloStrength = 0.45
    static func haloRadius(_ size: CGFloat) -> CGFloat { size / 2 + 13 }
    private var role: ThemeRoleName {
        switch tone {
        case .accent: return .accent
        case .warning: return .warning
        case .danger: return .danger
        case .off: return .muted
        }
    }
    private var color: Color { theme.color(role) }
}

/// A breathing light: the dot and its halo shrink to 0.88 and dim to 0.55 and back, 1.3 seconds each way.
private struct BreathingLight: UIViewRepresentable {
    let color: ThemeRGB
    func makeUIView(context: Context) -> LightLoopView { LightLoopView(frame: .zero) }
    func updateUIView(_ view: LightLoopView, context: Context) {
        view.paint(color)
        view.running = true
    }
}

/// `Light`'s dot and halo as layers. The halo is the same radial fade as a still light's (`Light.haloStrength` of the
/// colour at 0.3 of the dot's size out to clear at `Light.haloRadius`), so a breathing light looks like a still one.
final class LightLoopView: LoopingView {
    private let halo = CAGradientLayer()
    private let dot = CALayer()
    override init(frame: CGRect) {
        super.init(frame: frame)
        halo.type = .radial
        halo.startPoint = CGPoint(x: 0.5, y: 0.5)
        halo.endPoint = CGPoint(x: 1, y: 1)
        stage.layer.addSublayer(halo)
        stage.layer.addSublayer(dot)
    }
    required init?(coder: NSCoder) { fatalError("LightLoopView is made in code") }
    func paint(_ color: ThemeRGB) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dot.backgroundColor = color.uiColor(1).cgColor
        halo.colors = [color.uiColor(Light.haloStrength).cgColor, color.uiColor(0).cgColor]
        CATransaction.commit()
    }
    override func layoutStage() {
        let side = min(bounds.width, bounds.height)
        dot.frame = CGRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side)
        dot.cornerRadius = side / 2
        let radius = Light.haloRadius(side)
        halo.frame = CGRect(x: bounds.midX - radius, y: bounds.midY - radius, width: radius * 2, height: radius * 2)
        halo.locations = [NSNumber(value: Double(side * 0.3 / radius)), NSNumber(value: 1.0)]
    }
    override func makeLoops() -> [String: CAAnimation] {
        [
            "breathe-scale": Loops.basic("transform.scale", from: NSNumber(value: 1.0), to: NSNumber(value: 0.88), duration: 1.3, autoreverses: true),
            "breathe-opacity": Loops.basic("opacity", from: NSNumber(value: 1.0), to: NSNumber(value: 0.55), duration: 1.3, autoreverses: true)
        ]
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
    /// Whether it drifts. A sheet's wash holds still: drifting behind the New thread sheet's folder filter, Return failed
    /// to close the filter's keyboard in four of five CI runs, and never with the loops stopped.
    var drifts = true
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        // Drawn by Core Animation, which also drifts it, so the app does nothing while it moves.
        WashCanvas(primary: primary, secondary: secondary, warmth: warmth, warm: warm, drifting: drifting)
            .frame(height: height)
            .clipped()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
    private var drifting: Bool { drifts && !reduceMotion && !DebugFlags.still }
    private var dark: Bool { scheme == .dark }
    private var primary: UIColor {
        switch tone {
        case .normal: return theme.rgb(.accent).uiColor(dark ? 0.34 : 0.22)
        case .quiet: return theme.rgb(.accent).uiColor(0.16)
        case .failed: return theme.rgb(.danger).uiColor(0.16)
        }
    }
    private var secondary: UIColor {
        theme.rgb(.accent).uiColor(tone == .normal ? (dark ? 0.16 : 0.11) : 0.08)
    }
    private var warmth: UIColor { theme.rgb(.warning).uiColor(dark ? 0.22 : 0.2) }
}

/// The wash as layers. Takes resolved colours; new ones repaint it without restarting the drift.
private struct WashCanvas: UIViewRepresentable {
    let primary: UIColor
    let secondary: UIColor
    let warmth: UIColor
    let warm: Bool
    let drifting: Bool
    func makeUIView(context: Context) -> WashLoopView { WashLoopView(frame: .zero) }
    func updateUIView(_ view: WashLoopView, context: Context) {
        view.paint(primary: primary, secondary: secondary, warmth: warmth)
        view.showWarmth(warm)
        view.running = drifting
    }
}

/// The wash's three soft ellipses, each a radial gradient from its colour to clear at `fade` of its radii. Centres and
/// radii are fractions of the view's width and height. The warm one fades in and out over 1.6 seconds. While running,
/// the whole picture drifts: 26 seconds each way to 7% larger from its top edge, 3% of its width left and 2% of its
/// height down.
final class WashLoopView: LoopingView {
    private let primaryBlob = CAGradientLayer()
    private let secondaryBlob = CAGradientLayer()
    private let warmBlob = CAGradientLayer()
    private var warmShown: Bool? = nil
    override init(frame: CGRect) {
        super.init(frame: frame)
        // The drift grows the picture past the frame, so it is clipped there.
        clipsToBounds = true
        warmBlob.opacity = 0
        let blobs: [(CAGradientLayer, Double)] = [(primaryBlob, 0.72), (secondaryBlob, 0.72), (warmBlob, 0.70)]
        for (blob, fade) in blobs {
            blob.type = .radial
            blob.startPoint = CGPoint(x: 0.5, y: 0.5)
            blob.endPoint = CGPoint(x: 1, y: 1)
            blob.locations = [NSNumber(value: 0.0), NSNumber(value: fade)]
            stage.layer.addSublayer(blob)
        }
    }
    required init?(coder: NSCoder) { fatalError("WashLoopView is made in code") }
    func paint(primary: UIColor, secondary: UIColor, warmth: UIColor) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        primaryBlob.colors = [primary.cgColor, primary.withAlphaComponent(0).cgColor]
        secondaryBlob.colors = [secondary.cgColor, secondary.withAlphaComponent(0).cgColor]
        warmBlob.colors = [warmth.cgColor, warmth.withAlphaComponent(0).cgColor]
        CATransaction.commit()
    }
    /// Shows or hides the warm blob: at once the first time, then easing over 1.6 seconds from wherever it is.
    func showWarmth(_ warm: Bool) {
        if warmShown == warm { return }
        let first = warmShown == nil
        warmShown = warm
        let target: Float = warm ? 1 : 0
        let from: Float = warmBlob.presentation()?.opacity ?? warmBlob.opacity
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        warmBlob.opacity = target
        CATransaction.commit()
        if first { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = NSNumber(value: from)
        fade.toValue = NSNumber(value: target)
        fade.duration = 1.6
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        warmBlob.add(fade, forKey: "warmth")
    }
    override func layoutStage() {
        let width = bounds.width
        let tall = bounds.height
        place(primaryBlob, center: CGPoint(x: width * 0.116, y: 0), radii: CGSize(width: width * 0.72, height: tall * 0.52))
        place(secondaryBlob, center: CGPoint(x: width * 0.956, y: tall * 0.06), radii: CGSize(width: width * 0.576, height: tall * 0.44))
        place(warmBlob, center: CGPoint(x: width * 0.932, y: tall * 0.02), radii: CGSize(width: width * 0.552, height: tall * 0.40))
    }
    private func place(_ blob: CALayer, center: CGPoint, radii: CGSize) {
        blob.frame = CGRect(x: center.x - radii.width, y: center.y - radii.height, width: radii.width * 2, height: radii.height * 2)
    }
    override var loopSignature: [CGFloat] { [bounds.width, bounds.height] }
    override func makeLoops() -> [String: CAAnimation] {
        // SwiftUI's scale from the top edge then offset, as one transform about the stage's centre: growing by
        // `scale` from the top moves the centre down by half the growth in height.
        let scale: CGFloat = 1.07
        let shiftX = -bounds.width * 0.03
        let shiftY = bounds.height * (scale - 1) / 2 + bounds.height * 0.02
        let drifted = CATransform3DScale(CATransform3DMakeTranslation(shiftX, shiftY, 0), scale, scale, 1)
        return ["drift": Loops.basic("transform", from: NSValue(caTransform3D: CATransform3DIdentity), to: NSValue(caTransform3D: drifted),
                                     duration: 26, autoreverses: true)]
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
            .background { glow }
    }
    @ViewBuilder private var glow: some View {
        switch tone {
        case .needsYou: GlowLayer(radius: radius, color: theme.rgb(.warning), alpha: 0.5, base: theme.rgb(.surface), period: 6)
        case .working: GlowLayer(radius: radius, color: theme.rgb(.accent), alpha: 0.5, base: theme.rgb(.surface), period: 4.4)
        case .answered: GlowLayer(radius: radius, color: theme.rgb(.accent), alpha: 0.6, base: theme.rgb(.surface), period: nil)
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

/// The switch the UI journeys use to measure what the looping animations cost: `--ui-still` stops every one of them.
/// Debug builds only.
enum DebugFlags {
    #if DEBUG
    static let still = ProcessInfo.processInfo.arguments.contains("--ui-still")
    #else
    static let still = false
    #endif
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

/// The light behind a card, breathing slowly when it has a period. Still under Reduce Motion. Takes the card's corner
/// radius and resolved colours: the glow's colour opaque, with how strongly it shows as `alpha`.
private struct GlowLayer: View {
    let radius: CGFloat
    let color: ThemeRGB
    let alpha: CGFloat
    let base: ThemeRGB
    let period: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Group {
            if breathing {
                // Drawn by Core Animation, which fades it between 0.55 and full, half the period each way. It spills
                // past the card on purpose, so nothing here clips it.
                BreathingGlow(radius: radius, color: color, alpha: alpha, base: base, breath: (period ?? 4) / 2)
            } else {
                GlowImage(shape: RoundedRectangle(cornerRadius: radius, style: .continuous), color: color.color.opacity(Double(alpha)),
                          base: base.color)
                    .opacity(level)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
    private var breathing: Bool { period != nil && !reduceMotion && !DebugFlags.still }
    /// How bright the glow holds when it is not breathing.
    private var level: Double {
        if period == nil { return 1 }
        if reduceMotion { return 0.8 }
        return 0.55
    }
}

/// The still glow: the card's shape with a soft shadow drawn once.
private struct GlowImage: View {
    let shape: RoundedRectangle
    let color: Color
    let base: Color
    var body: some View {
        shape.fill(base).softShadow(shape, color: color, radius: 18, y: 10)
    }
}

/// The breathing glow as layers.
private struct BreathingGlow: UIViewRepresentable {
    let radius: CGFloat
    let color: ThemeRGB
    let alpha: CGFloat
    let base: ThemeRGB
    /// Seconds each way.
    let breath: Double
    func makeUIView(context: Context) -> GlowLoopView { GlowLoopView(frame: .zero) }
    func updateUIView(_ view: GlowLoopView, context: Context) {
        view.paint(radius: radius, glow: color, alpha: alpha, base: base)
        view.breath = breath
        view.running = true
    }
}

/// `GlowImage` as one layer: the card's shape filled with the surface, and the glow as its shadow. The shadow has an
/// explicit path, so Core Animation draws it without an offscreen pass. Its shadow radius is the still glow's blur of
/// 18: compared against CI captures, Core Animation's shadow radius and SwiftUI's blur radius spread the same distance.
/// The loop fades the whole of it between 0.55 and full, `breath` seconds each way.
final class GlowLoopView: LoopingView {
    private let card = CALayer()
    /// Seconds each way.
    var breath: Double = 2 {
        didSet { if breath != oldValue { refreshLoops(force: false) } }
    }
    override init(frame: CGRect) {
        super.init(frame: frame)
        // The glow spills past the card on purpose.
        clipsToBounds = false
        stage.clipsToBounds = false
        card.masksToBounds = false
        card.cornerCurve = .continuous
        card.shadowOffset = CGSize(width: 0, height: 10)
        card.shadowRadius = 18
        stage.layer.addSublayer(card)
    }
    required init?(coder: NSCoder) { fatalError("GlowLoopView is made in code") }
    func paint(radius: CGFloat, glow: ThemeRGB, alpha: CGFloat, base: ThemeRGB) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        card.backgroundColor = base.uiColor(1).cgColor
        card.shadowColor = glow.uiColor(1).cgColor
        card.shadowOpacity = Float(alpha)
        if card.cornerRadius != radius {
            card.cornerRadius = radius
            shapeShadow()
        }
        CATransaction.commit()
    }
    override func layoutStage() {
        card.frame = bounds
        shapeShadow()
    }
    private func shapeShadow() {
        card.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: card.cornerRadius).cgPath
    }
    override var loopSignature: [CGFloat] { [CGFloat(breath)] }
    override func makeLoops() -> [String: CAAnimation] {
        ["breathe": Loops.basic("opacity", from: NSNumber(value: 0.55), to: NSNumber(value: 1.0), duration: breath, autoreverses: true)]
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

/// The light that runs along the bottom of a working card. Absent under Reduce Motion. While it is not running it
/// draws nothing, as the old resting streak sat out of sight past the leading edge.
struct Runner: View {
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Group {
            if running {
                RunnerStreak(color: theme.rgb(.accent))
            } else {
                Color.clear
            }
        }
        .frame(height: 2)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
    private var running: Bool { !reduceMotion && !DebugFlags.still }
}

/// The runner's streak, moved by Core Animation.
private struct RunnerStreak: UIViewRepresentable {
    let color: ThemeRGB
    func makeUIView(context: Context) -> RunnerLoopView { RunnerLoopView(frame: .zero) }
    func updateUIView(_ view: RunnerLoopView, context: Context) {
        view.paint(color)
        view.running = true
    }
}

/// A streak 40% of the width wide, clear to 0.9 of the accent to clear, that crosses from just past the leading edge
/// to just past the trailing edge in 2.8 seconds and starts again.
final class RunnerLoopView: LoopingView {
    private let streak = CAGradientLayer()
    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        streak.startPoint = CGPoint(x: 0, y: 0.5)
        streak.endPoint = CGPoint(x: 1, y: 0.5)
        stage.layer.addSublayer(streak)
    }
    required init?(coder: NSCoder) { fatalError("RunnerLoopView is made in code") }
    func paint(_ color: ThemeRGB) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        streak.colors = [color.uiColor(0).cgColor, color.uiColor(0.9).cgColor, color.uiColor(0).cgColor]
        CATransaction.commit()
    }
    override func layoutStage() {
        // At rest the streak sits just past the leading edge; the loop slides the whole stage across.
        let width = bounds.width * 0.4
        streak.frame = CGRect(x: -width, y: 0, width: width, height: bounds.height)
    }
    override var loopSignature: [CGFloat] { [bounds.width] }
    override func makeLoops() -> [String: CAAnimation] {
        ["run": Loops.basic("transform.translation.x", from: NSNumber(value: 0.0), to: NSNumber(value: Double(bounds.width * 1.4)),
                            duration: 2.8, autoreverses: false)]
    }
}

// MARK: - Loops run by Core Animation

/// A looping animation SwiftUI would drive by evaluating views every frame in the app. Core Animation runs these in
/// the render server instead, so a page that only breathes and drifts leaves the app idle.
enum Loops {
    /// Eases in and out like SwiftUI's `.easeInOut`, repeats forever, and stays on the layer when it would finish.
    static func basic(_ keyPath: String, from: Any, to: Any, duration: CFTimeInterval, autoreverses: Bool) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.autoreverses = autoreverses
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.isRemovedOnCompletion = false
        return animation
    }
}

/// A view whose loops Core Animation runs. Subclasses draw on `stage`, which fills the view, and say which animations
/// loop on the stage's layer. They are added while the view is `running` and in a window, added afresh each time it
/// enters a window, added again if missing when the app returns to the foreground, and rebuilt only when
/// `loopSignature` changes, so new colours or a new height never restart a breath. It takes no touches and VoiceOver
/// does not see it.
class LoopingView: UIView {
    /// What subclasses draw on and the loops move. SwiftUI owns this view's own frame and transform; the stage is ours.
    let stage = UIView()
    /// Whether the loops should run.
    var running = false {
        didSet { if running != oldValue { refreshLoops(force: false) } }
    }
    private var builtKeys: [String] = []
    private var builtSignature: [CGFloat]? = nil

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        stage.backgroundColor = .clear
        stage.isUserInteractionEnabled = false
        addSubview(stage)
        NotificationCenter.default.addObserver(self, selector: #selector(returnedToForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("LoopingView is made in code") }

    /// Lays out what is drawn on the stage for the current bounds. Runs with implicit layer animations off.
    func layoutStage() {}
    /// The loops by key, for the current bounds.
    func makeLoops() -> [String: CAAnimation] { [:] }
    /// What the loops are built from beyond their keys, such as a width they travel; a change rebuilds them.
    var loopSignature: [CGFloat] { [] }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        stage.frame = bounds
        layoutStage()
        CATransaction.commit()
        refreshLoops(force: false)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        refreshLoops(force: true)
    }

    @objc private func returnedToForeground() {
        refreshLoops(force: false)
    }

    /// Adds the loops when they should run and are missing or out of date, and takes them off when they should not.
    func refreshLoops(force: Bool) {
        guard running, window != nil, bounds.width > 0, bounds.height > 0 else {
            stopLoops()
            return
        }
        let signature = loopSignature
        let missing = builtKeys.isEmpty || builtKeys.contains { stage.layer.animation(forKey: $0) == nil }
        if !force && !missing && builtSignature == signature { return }
        stopLoops()
        let loops = makeLoops()
        for (key, animation) in loops {
            stage.layer.add(animation, forKey: key)
        }
        builtKeys = Array(loops.keys)
        builtSignature = signature
    }

    private func stopLoops() {
        for key in builtKeys {
            stage.layer.removeAnimation(forKey: key)
        }
        builtKeys = []
        builtSignature = nil
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
            .softShadow(Circle(), color: theme.color(.accent).opacity(0.6), radius: 12, y: 6)
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
