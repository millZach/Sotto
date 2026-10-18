package com.millzach.sotto.core

/// An agent's name as Sotto shows it, from its provider ID. A provider this phone doesn't know reads "The agent".
object AgentNames {
    fun name(providerID: String?): String =
        mapOf(
            "claude" to "Claude Code", "codex" to "Codex", "grok" to "Grok Build", "devin" to "Devin", "muse" to "Muse",
            "opencode" to "OpenCode",
        )[providerID ?: ""] ?: "The agent"
}
