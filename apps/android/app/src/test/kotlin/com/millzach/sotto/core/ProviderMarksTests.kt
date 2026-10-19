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

    // A provider without a mark on Android draws nothing, never a guessed logo: its name is beside it.
    @Test fun aProviderWithoutAMarkDrawsNothing() {
        assertNull(ProviderMarks.mark("future"))
        assertNull(ProviderMarks.mark(null))
    }
}
