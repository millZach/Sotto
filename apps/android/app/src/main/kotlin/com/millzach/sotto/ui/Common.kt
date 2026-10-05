package com.millzach.sotto.ui

import android.text.format.DateUtils
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.ComputerStatus
import com.millzach.sotto.core.HostedThread
import com.millzach.sotto.core.Stamp
import com.millzach.sotto.core.ThreadState
import kotlinx.coroutines.launch

object Words {
    fun provider(id: String?): String =
        mapOf("claude" to "Claude Code", "codex" to "Codex", "grok" to "Grok Build", "devin" to "Devin")[id ?: ""] ?: "The agent"

    // "4 min. ago", or nothing when the host did not say.
    fun ago(iso: String?): String? {
        val instant = iso?.let(Stamp::date) ?: return null
        return DateUtils.getRelativeTimeSpanString(
            instant.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE,
        ).toString()
    }

    fun place(row: HostedThread): String = listOfNotNull(row.project, provider(row.thread.providerId), row.computer).joinToString(" · ")

    fun duration(ms: Double?): String? {
        if (ms == null || ms < 1000) return null
        val seconds = (ms / 1000).toInt()
        return if (seconds < 60) "${seconds}s" else "${seconds / 60}m ${seconds % 60}s"
    }

    // Inline Markdown as the desktop shows it: bold, italics, code and link text. Anything else stays as written.
    fun rendered(text: String, code: Color): AnnotatedString = buildAnnotatedString {
        val pattern = Regex("""\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])""")
        var last = 0
        for (match in pattern.findAll(text)) {
            append(text.substring(last, match.range.first))
            val (bold, mono, link, _, italic) = match.destructured
            when {
                bold.isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(bold) }
                mono.isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = code)) { append(mono) }
                link.isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(link) }
                else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(italic) }
            }
            last = match.range.last + 1
        }
        append(text.substring(last))
    }
}

@Composable
fun SectionHeading(title: String, count: Int? = null, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Row(modifier.fillMaxWidth().padding(top = 22.dp, bottom = 12.dp).semantics { heading() }) {
        Text(title, style = figtree(13, FontWeight.SemiBold), color = p.muted)
        Spacer(Modifier.weight(1f))
        if (count != null) Text("$count", style = figtree(13, FontWeight.SemiBold), color = p.muted)
    }
}

@Composable
fun StatusDot(state: ThreadState, size: Dp = 8.dp) {
    val p = LocalPalette.current
    val color = when (state) {
        ThreadState.NeedsAnswer, ThreadState.Asked -> p.warning
        ThreadState.Working, ThreadState.Waiting, ThreadState.Compacting -> p.accent
        ThreadState.Failed -> p.danger
        ThreadState.Done -> p.muted.copy(alpha = 0.55f)
    }
    val pulse = if (state == ThreadState.Working) {
        val transition = rememberInfiniteTransition(label = "working")
        val value by transition.animateFloat(1f, 0.35f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "dim")
        value
    } else 1f
    Box(Modifier.size(size).alpha(pulse).background(color, CircleShape))
}

@Composable
fun ComputerDot(status: ComputerStatus, size: Dp = 8.dp) {
    val p = LocalPalette.current
    val color = when (status) {
        ComputerStatus.Online -> p.accent
        ComputerStatus.Unreachable -> p.warning
        ComputerStatus.Connecting -> p.muted
    }
    Box(Modifier.size(size).background(color, CircleShape))
}

// The one accent action on a surface.
@Composable
fun ActionButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, wide: Boolean = false) {
    val p = LocalPalette.current
    Button(
        onClick = onClick, enabled = enabled,
        modifier = (if (wide) modifier.fillMaxWidth() else modifier).defaultMinSize(minHeight = 48.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = p.action, contentColor = p.actionInk,
            disabledContainerColor = p.action.copy(alpha = 0.5f), disabledContentColor = p.actionInk.copy(alpha = 0.7f),
        ),
    ) { Text(text, style = figtree(16, FontWeight.SemiBold)) }
}

// Every other action: the same shape on the raised surface.
@Composable
fun PlainButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, wide: Boolean = false, color: Color? = null) {
    val p = LocalPalette.current
    Button(
        onClick = onClick, enabled = enabled,
        modifier = (if (wide) modifier.fillMaxWidth() else modifier).defaultMinSize(minHeight = 44.dp),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = p.raised, contentColor = color ?: p.ink,
            disabledContainerColor = p.raised.copy(alpha = 0.5f), disabledContentColor = (color ?: p.ink).copy(alpha = 0.5f),
        ),
    ) { Text(text, style = figtree(15, FontWeight.SemiBold)) }
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    Column(
        modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(20.dp))
            .border(1.dp, p.border, RoundedCornerShape(20.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
fun CommandBox(command: String) {
    val p = LocalPalette.current
    SelectionContainer {
        Text(
            command, style = figtree(14).copy(fontFamily = FontFamily.Monospace), color = p.ink,
            modifier = Modifier.fillMaxWidth().background(p.canvas, RoundedCornerShape(10.dp))
                .border(1.dp, p.hairline, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) = HorizontalDivider(modifier, color = LocalPalette.current.hairline)

// Says what just went wrong, above whatever page is open.
@Composable
fun FeedbackBanner(model: AppModel, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val feedback = model.feedback ?: return
    Row(
        modifier.fillMaxWidth().background(p.raised, RoundedCornerShape(14.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(feedback, style = figtree(15), color = p.ink, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
        IconButton(onClick = { model.dismissFeedback() }) {
            Icon(Icons.Filled.Close, contentDescription = "Dismiss message", tint = p.muted)
        }
    }
}

// In a thread: says when its computer can't be reached, else what just went wrong.
@Composable
fun ComputerBanner(model: AppModel, hostID: String, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    if (model.status(hostID) == ComputerStatus.Unreachable) {
        Row(
            modifier.fillMaxWidth().background(p.warningSurface, RoundedCornerShape(14.dp)).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = p.warning)
            Column(Modifier.weight(1f)) {
                Text("Can’t reach ${model.name(hostID)}", style = figtree(16, FontWeight.SemiBold), color = p.ink)
                Text("Work carries on there. Your drafts are kept.", style = figtree(14), color = p.muted)
            }
            PlainButton("Reconnect", { scope.launch { model.connect(hostID) } },
                Modifier.semantics { contentDescription = "Reconnect to ${model.name(hostID)}" })
        }
    } else {
        FeedbackBanner(model, modifier)
    }
}

@Composable
fun Gap(height: Dp) = Spacer(Modifier.size(width = 0.dp, height = height))

@Composable
fun HGap(width: Dp) = Spacer(Modifier.width(width))

// A text field on the surface, in the field shape every form uses.
@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboard: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default,
    actions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default,
    singleLine: Boolean = true,
    maxLines: Int = 1,
    enabled: Boolean = true,
    mono: Boolean = false,
) {
    val p = LocalPalette.current
    val style = (if (mono) figtree(15).copy(fontFamily = FontFamily.Monospace) else figtree(16)).copy(color = p.ink)
    androidx.compose.foundation.text.BasicTextField(
        value = value, onValueChange = onValueChange, enabled = enabled, singleLine = singleLine,
        maxLines = if (singleLine) 1 else maxLines, textStyle = style, keyboardOptions = keyboard, keyboardActions = actions,
        cursorBrush = androidx.compose.ui.graphics.SolidColor(p.accent),
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).background(p.surface, RoundedCornerShape(12.dp))
                    .border(1.dp, p.border, RoundedCornerShape(12.dp)).padding(12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = p.muted))
                inner()
            }
        },
    )
}
