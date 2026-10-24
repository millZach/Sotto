package com.millzach.sotto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// OpenCode's mark is the desktop's (src/renderer/src/agents/ProviderMark.tsx): a 32 by 40 frame, with its inner square at 35%.
class ProviderMarksTests {
    @Test fun openCodeHasTheDesktopsFrameAndItsInnerSquareAt35Percent() {
        assertEquals(
            ProviderMarkShape(32f, 40f, listOf(MarkShape("M24 8H8V32H24V8ZM32 40H0V0H32V40Z", 1f), MarkShape("M24 8H8V32H24V8Z", 0.35f))),
            ProviderMarks.mark("opencode"),
        )
    }

    // Cursor's mark is the desktop's cube, drawn for Sotto and not Cursor's own logo (ADR-0127), in one colour.
    @Test fun cursorHasTheDesktopsCube() {
        assertEquals(
            ProviderMarkShape(24f, 24f, listOf(MarkShape("M12 2.4L19.51 6.74L12 11.08L4.49 6.74ZM3.69 8.12L11.2 12.46L11.2 21.14L3.69 16.8ZM12.8 12.46L20.31 8.12L20.31 16.8L12.8 21.14Z", 1f))),
            ProviderMarks.mark("cursor"),
        )
    }

    // A provider without a mark on Android draws nothing, never a guessed logo: its name is beside it.
    @Test fun aProviderWithoutAMarkDrawsNothing() {
        assertNull(ProviderMarks.mark("future"))
        assertNull(ProviderMarks.mark(null))
    }
}
