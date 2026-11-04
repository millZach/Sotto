/// Which text Figtree draws by itself. Every other character falls through to one of the iPhone's own fonts (ADR-0123),
/// and that font can make its line taller. Figtree's faces share one line height, so a line it draws alone is as tall as
/// any other at its size. The ranges are the Latin and punctuation in `Figtree.ttf`'s character map.
public enum FigtreeText {
    private static let drawn: [ClosedRange<UInt32>] = [
        0x20...0x7E, 0xA0...0xAC, 0xAE...0x113, 0x116...0x127, 0x12A...0x12B, 0x12E...0x137, 0x139...0x13E, 0x141...0x148,
        0x14A...0x14D, 0x150...0x161, 0x164...0x165, 0x16A...0x17E, 0x2013...0x2014, 0x2018...0x201A, 0x201C...0x201E,
        0x2020...0x2022, 0x2026...0x2026, 0x2039...0x203A, 0x20AC...0x20AC,
    ]
    /// Empty text has no line, so it is not a line Figtree draws.
    public static func drawsAlone(_ text: String) -> Bool {
        !text.isEmpty && text.unicodeScalars.allSatisfy { scalar in drawn.contains { $0.contains(scalar.value) } }
    }
}
