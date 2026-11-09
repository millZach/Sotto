package com.millzach.sotto.core

/**
 * Reasoning effort levels in words, as the desktop names them (`effortNames.ts`, #227): one name per level, found by its
 * spelling-free key, so `xhigh`, `x-high` and `Extra_High` all read XHigh. The provider's own id still goes back unchanged.
 */
object EffortWords {
    private val names = mapOf(
        "none" to "None", "minimal" to "Minimal", "low" to "Low", "medium" to "Medium", "high" to "High",
        // Its name, as Zach picked it for every surface (#227).
        "xhigh" to "XHigh", "max" to "Max",
        // Claude Code's own name, kept as it is (ADR-0148).
        "ultracode" to "Ultracode",
    )

    private fun key(id: String): String {
        val key = id.lowercase().filter { it != '-' && it != '_' && it != ' ' }
        return if (key == "extrahigh") "xhigh" else key
    }

    /** A level's name; one Sotto does not know shows as the provider names it, capitalised. */
    fun name(id: String): String = names[key(id)] ?: id.replaceFirstChar { it.uppercase() }
}
