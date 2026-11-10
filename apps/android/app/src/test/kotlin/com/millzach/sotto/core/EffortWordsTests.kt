package com.millzach.sotto.core

import org.junit.Assert.assertEquals
import org.junit.Test

class EffortWordsTests {
    @Test
    fun namesEachLevelOnceWhateverItsSpelling() {
        for (spelling in listOf("xhigh", "x-high", "Extra_High", "extra high")) assertEquals("XHigh", EffortWords.name(spelling))
        assertEquals(listOf("None", "Minimal", "Low", "Medium", "High", "Max", "Ultracode"),
            listOf("none", "minimal", "low", "medium", "high", "max", "ultracode").map(EffortWords::name))
        assertEquals("Ultra", EffortWords.name("ultra"))
    }
}
