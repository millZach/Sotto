package com.millzach.sotto.core

/// One shape of a provider's mark: an SVG path in the mark's view box, and how opaque it is drawn.
data class MarkShape(val path: String, val alpha: Float)

/// A provider's mark as the desktop draws it (src/renderer/src/agents/ProviderMark.tsx): its view box, then its shapes in
/// drawing order. The UI draws it in the colour of the words beside it (ProviderMark in ui/Common.kt).
data class ProviderMarkShape(val width: Float, val height: Float, val shapes: List<MarkShape>)

/// The marks Android draws. OpenCode's is the desktop's square frame, with its inner square drawn again at 35%, as OpenCode's
/// own mark has it (#1107). Cursor's is the desktop's cube of three faces, drawn for Sotto and not Cursor's own logo
/// (ADR-0125). A provider without one here draws nothing, never a guessed logo: its name is beside it.
object ProviderMarks {
    private val marks = mapOf(
        "opencode" to ProviderMarkShape(32f, 40f, listOf(
            MarkShape("M24 8H8V32H24V8ZM32 40H0V0H32V40Z", 1f),
            MarkShape("M24 8H8V32H24V8Z", 0.35f),
        )),
        "cursor" to ProviderMarkShape(24f, 24f, listOf(MarkShape("M12 2.4L19.51 6.74L12 11.08L4.49 6.74ZM3.69 8.12L11.2 12.46L11.2 21.14L3.69 16.8ZM12.8 12.46L20.31 8.12L20.31 16.8L12.8 21.14Z", 1f))),
    )

    fun mark(providerID: String?): ProviderMarkShape? = marks[providerID ?: ""]
}
