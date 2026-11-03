import Foundation

/// Callouts (ADR-0170, part 6): the numbered boxes with notes an agent placed on a picture it showed. Each is a dashed
/// box in the theme's accent with a pin at its top left that carries its number, drawn the same way on a tile, in the
/// viewer, in the mark-up editor and on a marked copy that keeps them, as the desktop draws them.
public enum Callouts {
    /// How a callout is drawn on a picture of `size`, in the picture's own pixels.
    public struct Shape: Equatable, Sendable {
        public let x: Double; public let y: Double; public let width: Double; public let height: Double
        public let line: Double; public let dash: [Double]; public let corner: Double
        /// The pin's radius and the size its number is set in.
        public let radius: Double; public let font: Double
    }

    /// Where a callout's box and pin go. `unit`, the picture's pixels to one point on screen, keeps the line and pin a
    /// fixed size on screen, as on a small tile; without it they are a share of the picture, as on the copy.
    public static func shape(_ callout: Activity.Media.Callout, size: MarkupSize, unit: Double? = nil) -> Shape {
        let longer = max(size.width, size.height)
        let line = unit.map { 1.5 * $0 } ?? longer / 260, radius = unit.map { 8 * $0 } ?? longer / 55
        return Shape(x: callout.x * size.width, y: callout.y * size.height, width: callout.w * size.width, height: callout.h * size.height,
                     line: line, dash: [line * 3, line * 2], corner: line * 2, radius: radius, font: radius * 1.1)
    }

    /// Where a picture of `size` sits in a frame of `width` by `height`: its scale and its top left, filled and cut to the
    /// frame (`fills`, as a tile shows it) or fitted whole inside it.
    public static func placement(of size: MarkupSize, inWidth width: Double, height: Double, fills: Bool) -> (scale: Double, x: Double, y: Double) {
        guard size.width > 0, size.height > 0 else { return (1, 0, 0) }
        let scale = fills ? max(width / size.width, height / size.height) : min(width / size.width, height / size.height)
        return (scale, (width - size.width * scale) / 2, (height - size.height * scale) / 2)
    }
}
