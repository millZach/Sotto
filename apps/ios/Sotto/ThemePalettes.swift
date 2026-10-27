// Generated from src/shared/themes/palettes.ts by tests/unit/shared/iosPalettes.test.ts. Do not edit by hand.
// To regenerate: SOTTO_WRITE_IOS_PALETTES=1 npx vitest run tests/unit/shared/iosPalettes.test.ts

/// A colour as sRGB components from 0 to 1.
struct ThemeRGB: Equatable {
    let red: Double
    let green: Double
    let blue: Double
    init(_ red: Double, _ green: Double, _ blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}

/// One half of a palette: the desktop's roles the iPhone paints, then four text colours derived from them that
/// keep 4.5:1 or better on every surface the iPhone tints (ADR-0051).
struct ThemeSwatch: Equatable {
    let canvas: ThemeRGB
    let surface: ThemeRGB
    let surfaceRaised: ThemeRGB
    let surfaceOverlay: ThemeRGB
    let text: ThemeRGB
    let textMuted: ThemeRGB
    let border: ThemeRGB
    let accent: ThemeRGB
    let accentForeground: ThemeRGB
    let accentSurface: ThemeRGB
    let warning: ThemeRGB
    let warningSurface: ThemeRGB
    let error: ThemeRGB
    let errorSurface: ThemeRGB
    let messageSurface: ThemeRGB
    let messageForeground: ThemeRGB
    let codeBackground: ThemeRGB
    let codeForeground: ThemeRGB
    let placeholder: ThemeRGB
    let mutedText: ThemeRGB
    let accentText: ThemeRGB
    let warningText: ThemeRGB
    let dangerText: ThemeRGB
}

/// One of Sotto's built-in palettes, light and dark.
struct ThemePalette: Identifiable, Equatable {
    let id: String
    let name: String
    let light: ThemeSwatch
    let dark: ThemeSwatch
}

enum ThemePalettes {
    /// The six palettes in the order the desktop lists them. The first is the default.
    static let all: [ThemePalette] = [sotto, hush, citrine, graphite, clay, fern]
    /// The palettes the desktop retired, and the one each moved to (ADR-0024).
    static let retired: [String: String] = ["linen": "clay", "nocturne": "graphite", "tropic": "fern"]

    static let sotto = ThemePalette(id: "sotto", name: "Sotto", light: sottoLight, dark: sottoDark)
    static let hush = ThemePalette(id: "hush", name: "Hush", light: hushLight, dark: hushDark)
    static let citrine = ThemePalette(id: "citrine", name: "Citrine", light: citrineLight, dark: citrineDark)
    static let graphite = ThemePalette(id: "graphite", name: "Graphite", light: graphiteLight, dark: graphiteDark)
    static let clay = ThemePalette(id: "clay", name: "Clay", light: clayLight, dark: clayDark)
    static let fern = ThemePalette(id: "fern", name: "Fern", light: fernLight, dark: fernDark)

    static let sottoLight = ThemeSwatch(
        canvas: ThemeRGB(0.9765, 0.9725, 0.9608),
        surface: ThemeRGB(0.9922, 0.9882, 0.9765),
        surfaceRaised: ThemeRGB(0.9490, 0.9412, 0.9255),
        surfaceOverlay: ThemeRGB(0.9373, 0.9255, 0.9098),
        text: ThemeRGB(0.1333, 0.1137, 0.0902),
        textMuted: ThemeRGB(0.4078, 0.3843, 0.3569),
        border: ThemeRGB(0.8353, 0.8157, 0.7843),
        accent: ThemeRGB(0.0000, 0.4902, 0.4549),
        accentForeground: ThemeRGB(0.9922, 0.9882, 0.9765),
        accentSurface: ThemeRGB(0.8118, 0.9255, 0.9059),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9686, 0.9373, 0.8902),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9725, 0.9020, 0.8941),
        messageSurface: ThemeRGB(0.9216, 0.9059, 0.8745),
        messageForeground: ThemeRGB(0.1333, 0.1137, 0.0902),
        codeBackground: ThemeRGB(0.9529, 0.9490, 0.9333),
        codeForeground: ThemeRGB(0.1333, 0.1137, 0.0902),
        placeholder: ThemeRGB(0.4353, 0.4118, 0.3804),
        mutedText: ThemeRGB(0.4078, 0.3843, 0.3569),
        accentText: ThemeRGB(0.1176, 0.4000, 0.3686),
        warningText: ThemeRGB(0.5137, 0.3373, 0.1333),
        dangerText: ThemeRGB(0.7098, 0.1922, 0.1804)
    )

    static let sottoDark = ThemeSwatch(
        canvas: ThemeRGB(0.0157, 0.0196, 0.0275),
        surface: ThemeRGB(0.0353, 0.0392, 0.0549),
        surfaceRaised: ThemeRGB(0.0667, 0.0745, 0.0863),
        surfaceOverlay: ThemeRGB(0.0941, 0.0980, 0.1137),
        text: ThemeRGB(0.9765, 0.9804, 0.9922),
        textMuted: ThemeRGB(0.6275, 0.6471, 0.6824),
        border: ThemeRGB(0.1647, 0.1843, 0.2235),
        accent: ThemeRGB(0.2784, 0.7216, 0.6627),
        accentForeground: ThemeRGB(0.0275, 0.0588, 0.0549),
        accentSurface: ThemeRGB(0.0471, 0.2314, 0.2118),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2275, 0.1882, 0.1216),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2392, 0.1373, 0.1373),
        messageSurface: ThemeRGB(0.0784, 0.0902, 0.1176),
        messageForeground: ThemeRGB(0.9765, 0.9804, 0.9922),
        codeBackground: ThemeRGB(0.0431, 0.0471, 0.0627),
        codeForeground: ThemeRGB(0.9765, 0.9804, 0.9922),
        placeholder: ThemeRGB(0.5804, 0.5922, 0.6196),
        mutedText: ThemeRGB(0.6275, 0.6471, 0.6824),
        accentText: ThemeRGB(0.4196, 0.7647, 0.7137),
        warningText: ThemeRGB(1.0000, 0.7569, 0.5176),
        dangerText: ThemeRGB(1.0000, 0.4627, 0.4510)
    )

    static let hushLight = ThemeSwatch(
        canvas: ThemeRGB(0.9529, 0.9529, 0.9412),
        surface: ThemeRGB(0.9216, 0.9373, 0.9294),
        surfaceRaised: ThemeRGB(0.8784, 0.8902, 0.8824),
        surfaceOverlay: ThemeRGB(0.8431, 0.8588, 0.8510),
        text: ThemeRGB(0.0745, 0.0902, 0.0824),
        textMuted: ThemeRGB(0.4118, 0.4235, 0.4118),
        border: ThemeRGB(0.7843, 0.8039, 0.7922),
        accent: ThemeRGB(0.3373, 0.4118, 0.3725),
        accentForeground: ThemeRGB(1.0000, 0.9804, 1.0000),
        accentSurface: ThemeRGB(0.8235, 0.8588, 0.8392),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9569, 0.9255, 0.8667),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9569, 0.8902, 0.8824),
        messageSurface: ThemeRGB(0.7961, 0.8353, 0.8118),
        messageForeground: ThemeRGB(0.0745, 0.0902, 0.0824),
        codeBackground: ThemeRGB(0.8980, 0.9098, 0.9020),
        codeForeground: ThemeRGB(0.0745, 0.0902, 0.0824),
        placeholder: ThemeRGB(0.3569, 0.3725, 0.3647),
        mutedText: ThemeRGB(0.3608, 0.3725, 0.3647),
        accentText: ThemeRGB(0.2745, 0.3333, 0.3020),
        warningText: ThemeRGB(0.4784, 0.3216, 0.1373),
        dangerText: ThemeRGB(0.6824, 0.1882, 0.1804)
    )

    static let hushDark = ThemeSwatch(
        canvas: ThemeRGB(0.0980, 0.1059, 0.1020),
        surface: ThemeRGB(0.1098, 0.1216, 0.1137),
        surfaceRaised: ThemeRGB(0.1412, 0.1529, 0.1490),
        surfaceOverlay: ThemeRGB(0.1647, 0.1765, 0.1725),
        text: ThemeRGB(0.9176, 0.9412, 0.9294),
        textMuted: ThemeRGB(0.5333, 0.5490, 0.5412),
        border: ThemeRGB(0.2471, 0.2627, 0.2549),
        accent: ThemeRGB(0.6157, 0.7059, 0.6588),
        accentForeground: ThemeRGB(0.1412, 0.0824, 0.1373),
        accentSurface: ThemeRGB(0.2039, 0.2392, 0.2196),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2431, 0.1843, 0.0863),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2392, 0.1294, 0.1333),
        messageSurface: ThemeRGB(0.2118, 0.2510, 0.2314),
        messageForeground: ThemeRGB(0.9176, 0.9412, 0.9294),
        codeBackground: ThemeRGB(0.1294, 0.1373, 0.1333),
        codeForeground: ThemeRGB(0.9176, 0.9412, 0.9294),
        placeholder: ThemeRGB(0.5647, 0.5882, 0.5765),
        mutedText: ThemeRGB(0.6275, 0.6471, 0.6353),
        accentText: ThemeRGB(0.6627, 0.7412, 0.7020),
        warningText: ThemeRGB(0.9804, 0.7412, 0.4902),
        dangerText: ThemeRGB(0.9961, 0.4863, 0.4667)
    )

    static let citrineLight = ThemeSwatch(
        canvas: ThemeRGB(0.9686, 0.9647, 0.9412),
        surface: ThemeRGB(0.9490, 0.9451, 0.9255),
        surfaceRaised: ThemeRGB(0.9059, 0.8980, 0.8824),
        surfaceOverlay: ThemeRGB(0.8706, 0.8667, 0.8510),
        text: ThemeRGB(0.1059, 0.0863, 0.0235),
        textMuted: ThemeRGB(0.4392, 0.4275, 0.3804),
        border: ThemeRGB(0.8196, 0.8078, 0.7804),
        accent: ThemeRGB(0.5412, 0.4353, 0.0000),
        accentForeground: ThemeRGB(1.0000, 0.9804, 1.0000),
        accentSurface: ThemeRGB(0.8941, 0.8588, 0.7529),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9725, 0.9373, 0.8667),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9686, 0.9020, 0.8824),
        messageSurface: ThemeRGB(0.8706, 0.8353, 0.7176),
        messageForeground: ThemeRGB(0.1059, 0.0863, 0.0235),
        codeBackground: ThemeRGB(0.9216, 0.9176, 0.9059),
        codeForeground: ThemeRGB(0.1059, 0.0863, 0.0235),
        placeholder: ThemeRGB(0.4000, 0.3765, 0.3137),
        mutedText: ThemeRGB(0.3922, 0.3765, 0.3294),
        accentText: ThemeRGB(0.4353, 0.3529, 0.0275),
        warningText: ThemeRGB(0.4980, 0.3176, 0.0588),
        dangerText: ThemeRGB(0.6980, 0.1804, 0.1490)
    )

    static let citrineDark = ThemeSwatch(
        canvas: ThemeRGB(0.0706, 0.0706, 0.0667),
        surface: ThemeRGB(0.0824, 0.0824, 0.0824),
        surfaceRaised: ThemeRGB(0.1137, 0.1137, 0.1137),
        surfaceOverlay: ThemeRGB(0.1373, 0.1373, 0.1373),
        text: ThemeRGB(0.9608, 0.9373, 0.8353),
        textMuted: ThemeRGB(0.5333, 0.5216, 0.4667),
        border: ThemeRGB(0.2196, 0.2196, 0.2196),
        accent: ThemeRGB(0.9490, 0.8157, 0.1412),
        accentForeground: ThemeRGB(0.1412, 0.0824, 0.1373),
        accentSurface: ThemeRGB(0.2000, 0.1922, 0.1490),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2196, 0.1569, 0.0549),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2157, 0.1020, 0.1020),
        messageSurface: ThemeRGB(0.2118, 0.2000, 0.1529),
        messageForeground: ThemeRGB(0.9608, 0.9373, 0.8353),
        codeBackground: ThemeRGB(0.1020, 0.1020, 0.1020),
        codeForeground: ThemeRGB(0.9608, 0.9373, 0.8353),
        placeholder: ThemeRGB(0.5686, 0.5490, 0.4510),
        mutedText: ThemeRGB(0.6549, 0.6431, 0.5725),
        accentText: ThemeRGB(0.9490, 0.8353, 0.3294),
        warningText: ThemeRGB(0.9922, 0.7373, 0.4431),
        dangerText: ThemeRGB(1.0000, 0.4824, 0.4353)
    )

    static let graphiteLight = ThemeSwatch(
        canvas: ThemeRGB(0.9843, 0.9843, 0.9843),
        surface: ThemeRGB(0.9961, 0.9961, 0.9961),
        surfaceRaised: ThemeRGB(0.9373, 0.9373, 0.9373),
        surfaceOverlay: ThemeRGB(0.9216, 0.9216, 0.9216),
        text: ThemeRGB(0.0706, 0.0706, 0.0706),
        textMuted: ThemeRGB(0.3647, 0.3647, 0.3647),
        border: ThemeRGB(0.8510, 0.8510, 0.8510),
        accent: ThemeRGB(0.0863, 0.0863, 0.0863),
        accentForeground: ThemeRGB(0.9882, 0.9882, 0.9882),
        accentSurface: ThemeRGB(0.8941, 0.8941, 0.8941),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9686, 0.9373, 0.8902),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9725, 0.9020, 0.8941),
        messageSurface: ThemeRGB(0.9020, 0.9020, 0.9020),
        messageForeground: ThemeRGB(0.0706, 0.0706, 0.0706),
        codeBackground: ThemeRGB(0.9529, 0.9529, 0.9529),
        codeForeground: ThemeRGB(0.0706, 0.0706, 0.0706),
        placeholder: ThemeRGB(0.3882, 0.3882, 0.3882),
        mutedText: ThemeRGB(0.3647, 0.3647, 0.3647),
        accentText: ThemeRGB(0.0824, 0.0824, 0.0824),
        warningText: ThemeRGB(0.4745, 0.3098, 0.1294),
        dangerText: ThemeRGB(0.6824, 0.1765, 0.1765)
    )

    static let graphiteDark = ThemeSwatch(
        canvas: ThemeRGB(0.0314, 0.0314, 0.0314),
        surface: ThemeRGB(0.0549, 0.0549, 0.0549),
        surfaceRaised: ThemeRGB(0.0902, 0.0902, 0.0902),
        surfaceOverlay: ThemeRGB(0.1176, 0.1176, 0.1176),
        text: ThemeRGB(0.9529, 0.9529, 0.9529),
        textMuted: ThemeRGB(0.6196, 0.6196, 0.6196),
        border: ThemeRGB(0.1569, 0.1569, 0.1569),
        accent: ThemeRGB(0.9333, 0.9333, 0.9333),
        accentForeground: ThemeRGB(0.0353, 0.0353, 0.0353),
        accentSurface: ThemeRGB(0.1804, 0.1804, 0.1804),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2275, 0.1882, 0.1216),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2392, 0.1373, 0.1373),
        messageSurface: ThemeRGB(0.1255, 0.1255, 0.1255),
        messageForeground: ThemeRGB(0.9529, 0.9529, 0.9529),
        codeBackground: ThemeRGB(0.0549, 0.0549, 0.0549),
        codeForeground: ThemeRGB(0.9529, 0.9529, 0.9529),
        placeholder: ThemeRGB(0.5725, 0.5725, 0.5725),
        mutedText: ThemeRGB(0.6314, 0.6314, 0.6314),
        accentText: ThemeRGB(0.9373, 0.9373, 0.9373),
        warningText: ThemeRGB(0.9922, 0.7451, 0.5020),
        dangerText: ThemeRGB(1.0000, 0.4667, 0.4510)
    )

    static let clayLight = ThemeSwatch(
        canvas: ThemeRGB(0.9843, 0.9608, 0.9412),
        surface: ThemeRGB(0.9922, 0.9765, 0.9647),
        surfaceRaised: ThemeRGB(0.9647, 0.9059, 0.8745),
        surfaceOverlay: ThemeRGB(0.9529, 0.8941, 0.8588),
        text: ThemeRGB(0.1804, 0.1137, 0.0902),
        textMuted: ThemeRGB(0.4392, 0.3569, 0.3255),
        border: ThemeRGB(0.8824, 0.8078, 0.7686),
        accent: ThemeRGB(0.6941, 0.2667, 0.1255),
        accentForeground: ThemeRGB(0.9961, 0.9843, 0.9725),
        accentSurface: ThemeRGB(0.9686, 0.8549, 0.8157),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9765, 0.9294, 0.8667),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9804, 0.8941, 0.8824),
        messageSurface: ThemeRGB(0.9608, 0.8510, 0.8000),
        messageForeground: ThemeRGB(0.1804, 0.1137, 0.0902),
        codeBackground: ThemeRGB(0.9725, 0.9373, 0.9176),
        codeForeground: ThemeRGB(0.1804, 0.1137, 0.0902),
        placeholder: ThemeRGB(0.4314, 0.3529, 0.3176),
        mutedText: ThemeRGB(0.4392, 0.3569, 0.3255),
        accentText: ThemeRGB(0.5725, 0.2353, 0.1255),
        warningText: ThemeRGB(0.5451, 0.3333, 0.1294),
        dangerText: ThemeRGB(0.7216, 0.1843, 0.1804)
    )

    static let clayDark = ThemeSwatch(
        canvas: ThemeRGB(0.0980, 0.0588, 0.0471),
        surface: ThemeRGB(0.1216, 0.0784, 0.0627),
        surfaceRaised: ThemeRGB(0.1804, 0.1216, 0.1020),
        surfaceOverlay: ThemeRGB(0.2118, 0.1490, 0.1255),
        text: ThemeRGB(0.9725, 0.9333, 0.9020),
        textMuted: ThemeRGB(0.7216, 0.6392, 0.5922),
        border: ThemeRGB(0.2667, 0.1961, 0.1686),
        accent: ThemeRGB(0.9412, 0.5294, 0.3686),
        accentForeground: ThemeRGB(0.1333, 0.0667, 0.0431),
        accentSurface: ThemeRGB(0.2863, 0.1647, 0.1216),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2431, 0.1882, 0.1216),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2471, 0.1333, 0.1294),
        messageSurface: ThemeRGB(0.2549, 0.1569, 0.1255),
        messageForeground: ThemeRGB(0.9725, 0.9333, 0.9020),
        codeBackground: ThemeRGB(0.1176, 0.0784, 0.0667),
        codeForeground: ThemeRGB(0.9725, 0.9333, 0.9020),
        placeholder: ThemeRGB(0.6706, 0.5882, 0.5451),
        mutedText: ThemeRGB(0.7216, 0.6392, 0.5922),
        accentText: ThemeRGB(0.9529, 0.5961, 0.4588),
        warningText: ThemeRGB(0.9961, 0.7373, 0.4784),
        dangerText: ThemeRGB(1.0000, 0.4471, 0.4314)
    )

    static let fernLight = ThemeSwatch(
        canvas: ThemeRGB(0.9686, 0.9765, 0.9647),
        surface: ThemeRGB(0.9843, 0.9882, 0.9804),
        surfaceRaised: ThemeRGB(0.9059, 0.9373, 0.9059),
        surfaceOverlay: ThemeRGB(0.8941, 0.9255, 0.8941),
        text: ThemeRGB(0.0706, 0.1176, 0.0784),
        textMuted: ThemeRGB(0.3294, 0.3843, 0.3373),
        border: ThemeRGB(0.8078, 0.8549, 0.8078),
        accent: ThemeRGB(0.0745, 0.4667, 0.2196),
        accentForeground: ThemeRGB(0.9804, 0.9922, 0.9765),
        accentSurface: ThemeRGB(0.8235, 0.9216, 0.8314),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.9647, 0.9373, 0.8824),
        error: ThemeRGB(0.9843, 0.1725, 0.2118),
        errorSurface: ThemeRGB(0.9725, 0.9020, 0.8941),
        messageSurface: ThemeRGB(0.8353, 0.9176, 0.8353),
        messageForeground: ThemeRGB(0.0706, 0.1176, 0.0784),
        codeBackground: ThemeRGB(0.9412, 0.9569, 0.9373),
        codeForeground: ThemeRGB(0.0706, 0.1176, 0.0784),
        placeholder: ThemeRGB(0.3451, 0.3922, 0.3529),
        mutedText: ThemeRGB(0.3294, 0.3843, 0.3373),
        accentText: ThemeRGB(0.0941, 0.3843, 0.1882),
        warningText: ThemeRGB(0.4824, 0.3412, 0.1255),
        dangerText: ThemeRGB(0.6941, 0.2039, 0.1765)
    )

    static let fernDark = ThemeSwatch(
        canvas: ThemeRGB(0.0353, 0.0510, 0.0431),
        surface: ThemeRGB(0.0549, 0.0745, 0.0627),
        surfaceRaised: ThemeRGB(0.0902, 0.1216, 0.1020),
        surfaceOverlay: ThemeRGB(0.1098, 0.1451, 0.1255),
        text: ThemeRGB(0.9412, 0.9608, 0.9373),
        textMuted: ThemeRGB(0.6235, 0.6706, 0.6314),
        border: ThemeRGB(0.1490, 0.1961, 0.1725),
        accent: ThemeRGB(0.3686, 0.8588, 0.5059),
        accentForeground: ThemeRGB(0.0235, 0.0824, 0.0471),
        accentSurface: ThemeRGB(0.0980, 0.1961, 0.1255),
        warning: ThemeRGB(0.9961, 0.6039, 0.0000),
        warningSurface: ThemeRGB(0.2275, 0.1882, 0.1216),
        error: ThemeRGB(0.9843, 0.2549, 0.2902),
        errorSurface: ThemeRGB(0.2392, 0.1373, 0.1373),
        messageSurface: ThemeRGB(0.1098, 0.1725, 0.1294),
        messageForeground: ThemeRGB(0.9412, 0.9608, 0.9373),
        codeBackground: ThemeRGB(0.0588, 0.0784, 0.0667),
        codeForeground: ThemeRGB(0.9412, 0.9608, 0.9373),
        placeholder: ThemeRGB(0.5765, 0.6235, 0.5843),
        mutedText: ThemeRGB(0.6235, 0.6706, 0.6314),
        accentText: ThemeRGB(0.4824, 0.8784, 0.5765),
        warningText: ThemeRGB(0.9882, 0.7490, 0.4941),
        dangerText: ThemeRGB(1.0000, 0.4510, 0.4353)
    )
}
