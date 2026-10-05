package com.millzach.sotto.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Error
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.Activity
import com.millzach.sotto.core.AgentRequest
import com.millzach.sotto.core.Message
import com.millzach.sotto.core.PendingOperation
import com.millzach.sotto.core.PermissionChoice
import com.millzach.sotto.core.Question
import com.millzach.sotto.core.QuestionAnswer
import com.millzach.sotto.core.RequestOption
import com.millzach.sotto.core.ThreadDetail
import com.millzach.sotto.core.ThreadRef
import com.millzach.sotto.core.ThreadSummary

// One thread: its messages as a conversation, or its activity, with the reply box under both. A waiting
// question or permission opens as a sheet; dismissed, the reply box offers it again. Everything here goes to
// the thread's own computer.
@Composable
fun ThreadScreen(model: AppModel, ref: ThreadRef, close: () -> Unit) {
    val p = LocalPalette.current
    var pane by rememberSaveable { mutableStateOf("Messages") }
    var open by remember { mutableStateOf<AgentRequest?>(null) }
    val setAside = remember { mutableStateMapOf<String, Boolean>() }
    val thread = model.thread(ref)
    val detail = model.detail(ref)

    // Opens the thread's waiting request once; after "Not now" it waits in the reply box.
    fun offer() {
        if (open != null) return
        open = model.thread(ref)?.requests?.firstOrNull { setAside[it.id] != true }
    }
    LaunchedEffect(ref) { model.select(ref); offer() }
    LaunchedEffect(thread?.requests?.map { it.id }) { offer() }
    BackHandler { model.launch { if (selected == ref) select(null) }; close() }

    Column(Modifier.fillMaxSize().background(p.canvas).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { model.launch { if (selected == ref) select(null) }; close() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to threads", tint = p.ink)
            }
            Text(model.name(ref.hostID), style = figtree(16, FontWeight.SemiBold), color = p.ink, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Box(Modifier.size(48.dp))
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(thread?.title ?: "Thread", style = figtree(25, FontWeight.SemiBold), color = p.ink, modifier = Modifier.semantics { heading() })
            Text("${Words.provider(thread?.providerId)} · ${model.name(ref.hostID)}", style = figtree(13), color = p.muted)
        }
        Row(Modifier.padding(horizontal = 22.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            listOf("Messages", "Activity").forEach { choice ->
                Column(
                    Modifier.defaultMinSize(minHeight = 44.dp).clickable { pane = choice }.semantics { selected = pane == choice },
                    verticalArrangement = Arrangement.Bottom,
                ) {
                    Text(choice, style = figtree(15), color = if (pane == choice) p.ink else p.muted, modifier = Modifier.padding(vertical = 10.dp))
                    Box(Modifier.height(2.dp).width(if (choice == "Messages") 72.dp else 58.dp).background(if (pane == choice) p.accent else p.canvas))
                }
            }
        }
        Hairline()
        ComputerBanner(model, ref.hostID, Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        val problem = model.detailProblem
        if (problem != null && model.online(ref.hostID)) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(problem, style = figtree(16), color = p.muted)
                PlainButton("Try again", { model.launch { select(ref) } })
            }
        }
        Box(Modifier.weight(1f)) {
            if (pane == "Messages") MessagesPane(model, ref, detail, thread) else ActivityPane(detail, model.online(ref.hostID))
        }
        Composer(model, ref) { open = it }
    }

    val request = open
    if (request != null) {
        RequestSheet(model, ref, request) {
            setAside[request.id] = true
            open = null
            offer()
        }
    }
}

// MARK: Messages

@Composable
private fun MessagesPane(model: AppModel, ref: ThreadRef, detail: ThreadDetail?, thread: ThreadSummary?) {
    val p = LocalPalette.current
    val online = model.online(ref.hostID)
    val list = rememberLazyListState()
    var dismissMarker by remember { mutableStateOf<PendingOperation?>(null) }
    val messages = detail?.messages ?: emptyList()
    val markers = model.pending(ref)
    val failed = model.failedReplies[ref.id]
    val running = detail?.activities?.lastOrNull { it.status == "running" && it.kind != "turn" }
    // Kept at the newest message as the thread grows.
    LaunchedEffect(detail?.revision, markers.size) {
        val last = list.layoutInfo.totalItemsCount - 1
        if (last >= 0) list.scrollToItem(last)
    }
    LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (detail?.earlierAvailable == true || thread?.earlierAvailable == true) item {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                PlainButton("Show earlier messages", { model.launch { earlier(ref) } }, enabled = online)
            }
        }
        if (detail != null) {
            items(messages, key = { it.id }) { MessageBubble(it, Words.provider(thread?.providerId)) }
        } else if (model.detailProblem == null || !online) item {
            Text(
                if (model.status(ref.hostID) == com.millzach.sotto.core.ComputerStatus.Unreachable) "Reconnect to read this thread." else "Reading this thread…",
                style = figtree(16), color = p.muted, modifier = Modifier.padding(vertical = 24.dp),
            )
        }
        items(markers, key = { it.id }) { UnconfirmedRow(model, it, model.submitted[it.id]) { dismissMarker = it } }
        if (failed != null) item {
            Card {
                Text("Your reply wasn’t sent", style = figtree(16, FontWeight.SemiBold), color = p.ink)
                SelectionContainer { Text(failed, style = figtree(16), color = p.ink) }
                PlainButton("Put it back in the reply box", { model.restoreReply(ref) }, enabled = model.drafts[ref.id].isNullOrEmpty())
            }
        }
        if (running != null) item {
            Row(Modifier.padding(start = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), color = p.muted, strokeWidth = 2.dp)
                Text("  ${running.subject ?: running.title}", style = figtree(15), color = p.muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            }
        }
    }
    val marker = dismissMarker
    if (marker != null) {
        AlertDialog(
            onDismissRequest = { dismissMarker = null },
            title = { Text("Stop waiting for confirmation?") },
            text = { Text("It may already have reached ${model.name(ref.hostID)}. Nothing is sent again.") },
            confirmButton = { TextButton(onClick = { model.acknowledgeUnknown(marker.id); dismissMarker = null }) { Text("I checked the thread") } },
            dismissButton = { TextButton(onClick = { dismissMarker = null }) { Text("Cancel") } },
            containerColor = p.surface,
        )
    }
}

@Composable
private fun MessageBubble(message: Message, provider: String) {
    val p = LocalPalette.current
    when (message.role) {
        "user" -> Box(Modifier.fillMaxWidth().padding(start = 48.dp), contentAlignment = Alignment.CenterEnd) {
            Column(
                Modifier.background(p.bubble, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) { MessageContent(message, p.bubbleInk) }
        }
        "assistant" -> Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(provider, style = figtree(13, FontWeight.SemiBold), color = p.muted)
            MessageContent(message, p.ink)
        }
        else -> Text(message.text, style = figtree(13), color = p.muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun MessageContent(message: Message, ink: androidx.compose.ui.graphics.Color) {
    val p = LocalPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SelectionContainer { Text(Words.rendered(message.text, p.raised), style = figtree(17).copy(lineHeight = androidx.compose.ui.unit.TextUnit.Unspecified), color = ink) }
        message.attachments?.forEach { attachment ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = p.muted, modifier = Modifier.size(14.dp))
                Text(" ${attachment.name} (open on the desktop)", style = figtree(13), color = p.muted)
            }
        }
    }
}

// A reply, answer or stop the thread's computer hasn't confirmed. It is never sent again on its own.
@Composable
private fun UnconfirmedRow(model: AppModel, item: PendingOperation, text: String?, dismiss: () -> Unit) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (text != null) {
            Text(
                text, style = figtree(16), color = p.bubbleInk,
                modifier = Modifier.padding(start = 48.dp).background(p.bubble.copy(alpha = 0.6f), RoundedCornerShape(20.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
        Row(verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = p.warning, modifier = Modifier.size(16.dp))
            Text(
                " " + when (item.kind) {
                    "answer" -> "Your answer isn’t confirmed. Check the thread before you answer again."
                    "interrupt" -> "Stop isn’t confirmed. Check whether the thread is still working."
                    else -> "Not confirmed. Check the thread before you send it again."
                },
                style = figtree(13), color = p.warning,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlainButton("I checked", dismiss)
            PlainButton("Check again", { model.launch { checkDelivery(item.hostID) } }, enabled = model.online(item.hostID))
        }
    }
}

// MARK: Activity

@Composable
private fun ActivityPane(detail: ThreadDetail?, online: Boolean) {
    val p = LocalPalette.current
    val rows = (detail?.activities ?: emptyList()).filter { it.kind != "turn" }.sortedBy { it.sequence }
    val list = rememberLazyListState()
    LaunchedEffect(rows.size) { if (rows.isNotEmpty()) list.scrollToItem(rows.size - 1) }
    LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        if (detail == null) item { Text(if (online) "Reading this thread…" else "Reconnect to read this thread.", style = figtree(16), color = p.muted, modifier = Modifier.padding(vertical = 24.dp)) }
        else if (rows.isEmpty()) item { Text("No activity yet.", style = figtree(16), color = p.muted, modifier = Modifier.padding(vertical = 24.dp)) }
        items(rows, key = { it.id }) { record ->
            ActivityRow(record)
            Hairline(Modifier.padding(start = 34.dp))
        }
    }
}

@Composable
private fun ActivityRow(record: Activity) {
    val p = LocalPalette.current
    val tint = when (record.status) { "running" -> p.accent; "failed" -> p.danger; else -> p.muted }
    val icon = when (record.kind) {
        "command" -> Icons.Outlined.Terminal
        "file-change" -> Icons.Outlined.Description
        "tool" -> Icons.Outlined.Build
        "reasoning" -> Icons.Outlined.ChatBubbleOutline
        "plan" -> Icons.Outlined.Checklist
        "subagent" -> Icons.Outlined.Group
        "compaction" -> Icons.Outlined.Compress
        else -> Icons.Outlined.Info
    }
    val meta = when (record.status) {
        "failed" -> record.exitCode?.let { "Failed ($it)" } ?: "Failed"
        "interrupted" -> "Stopped"
        else -> Words.duration(record.durationMs)
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
            if (record.status == "running") CircularProgressIndicator(Modifier.size(14.dp), color = p.accent, strokeWidth = 2.dp)
            else Icon(if (record.status == "failed") Icons.Outlined.Error else icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        }
        HGap(12.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(record.title, style = figtree(15, FontWeight.SemiBold), color = if (record.status == "running") p.accent else p.ink)
            val subject = record.subject
            if (subject != null && subject != record.title) {
                Text(subject, style = figtree(13).copy(fontFamily = FontFamily.Monospace), color = p.muted, maxLines = 2, overflow = TextOverflow.MiddleEllipsis)
            }
        }
        if (meta != null) Text(meta, style = figtree(13), color = if (record.status == "failed") p.danger else p.muted)
    }
}

// MARK: Reply box

@Composable
private fun Composer(model: AppModel, ref: ThreadRef, openRequest: (AgentRequest) -> Unit) {
    val p = LocalPalette.current
    val requests = model.thread(ref)?.requests ?: emptyList()
    Column(Modifier.fillMaxWidth().background(p.canvas).navigationBarsPadding()) {
        Hairline()
        if (requests.isNotEmpty()) {
            if (requests.size > 1) {
                var menu by remember { mutableStateOf(false) }
                Box(Modifier.padding(12.dp)) {
                    ActionButton("Review ${requests.size} requests", { menu = true }, wide = true)
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = p.raised) {
                        requests.forEach { pending ->
                            DropdownMenuItem(
                                text = { Text(pending.questions?.firstOrNull()?.question ?: pending.text, style = figtree(16), color = p.ink) },
                                onClick = { menu = false; openRequest(pending) },
                            )
                        }
                    }
                }
            } else {
                val request = requests.first()
                ActionButton(
                    if (request.kind == "permission") "Review the permission" else "Answer the question", { openRequest(request) },
                    Modifier.padding(12.dp), wide = true,
                )
            }
        } else {
            val draft = model.drafts[ref.id] ?: ""
            val canSend = model.canSend(ref) && draft.isNotBlank()
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                BasicTextField(
                    value = draft, onValueChange = { model.drafts = model.drafts + (ref.id to it) },
                    maxLines = 6, textStyle = figtree(17).copy(color = p.ink), cursorBrush = SolidColor(p.accent),
                    modifier = Modifier.weight(1f).semantics { contentDescription = "Reply to this thread" },
                    decorationBox = { inner ->
                        Box(
                            Modifier.fillMaxWidth().background(p.raised, RoundedCornerShape(22.dp)).padding(horizontal = 16.dp, vertical = 11.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            if (draft.isEmpty()) Text("Reply", style = figtree(17), color = p.muted)
                            inner()
                        }
                    },
                )
                HGap(8.dp)
                if (model.canInterrupt(ref)) {
                    IconButton(
                        onClick = { model.launch { interrupt(ref) } },
                        modifier = Modifier.size(44.dp).background(p.raised, CircleShape),
                    ) { Icon(Icons.Filled.Stop, contentDescription = "Stop this turn", tint = p.ink) }
                } else {
                    IconButton(
                        onClick = { model.launch { send(ref) } }, enabled = canSend,
                        modifier = Modifier.size(44.dp).background(if (canSend) p.action else p.raised, CircleShape),
                    ) { Icon(Icons.Filled.ArrowUpward, contentDescription = "Send reply", tint = if (canSend) p.actionInk else p.muted) }
                }
            }
        }
    }
}

// MARK: Question and permission sheet

// The whole request: its context and every choice. Nothing is chosen for the user, and a question is sent
// only when they press Send answer.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RequestSheet(model: AppModel, ref: ThreadRef, request: AgentRequest, dismiss: () -> Unit) {
    val p = LocalPalette.current
    val answers = remember { mutableStateMapOf<String, QuestionAnswer>() }
    var choice by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    val thread = model.thread(ref)
    val computer = model.name(ref.hostID)
    // The request as the computer holds it now; null once it is answered or replaced.
    val current = thread?.requests?.firstOrNull { it.id == request.id }
    LaunchedEffect(current == null && model.pending(ref).isEmpty()) { if (current == null && model.pending(ref).isEmpty()) dismiss() }

    ModalBottomSheet(onDismissRequest = dismiss, containerColor = p.surface) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (current == null) {
                Text("This request was answered or changed.", style = figtree(17, FontWeight.SemiBold), color = p.ink)
                PlainButton("Close", dismiss, wide = true)
                return@Column
            }
            Text(title(current, thread), style = figtree(22, FontWeight.Bold), color = p.ink, modifier = Modifier.semantics { heading() })
            Text(thread.title, style = figtree(15), color = p.muted)
            current.context?.let { context ->
                context.command?.let { CommandBox(it) }
                context.cwd?.let { Text("in $it on $computer", style = figtree(13), color = p.muted) }
                context.details?.let { SelectionContainer { Text(it, style = figtree(15), color = p.ink) } }
            }
            if (current.kind == "permission" && current.context?.command == null) SelectionContainer { Text(current.text, style = figtree(16), color = p.ink) }
            val enabled = model.canAnswer(current, ref)
            when {
                !current.supported -> Text("This request can’t be answered here. Check the thread, or answer it on $computer.", style = figtree(15), color = p.muted)
                !model.mayAnswer(ref.hostID) -> Text("This phone can’t answer on $computer yet. Turn on Can answer for it in Sotto on $computer, or answer there.", style = figtree(15), color = p.muted)
                current.kind == "permission" -> {
                    val choices = current.permissionChoices
                    if (choices != null) {
                        choices.sortedBy { rank(it) }.forEach { option ->
                            val send = { model.launch { answer(current, ref, choice = option.id) }; Unit }
                            if (option.kind == "allow-once") ChoiceAction(option, send, enabled, primary = true)
                            else ChoiceAction(option, send, enabled, primary = false)
                        }
                    } else {
                        ActionButton("Allow", { model.launch { answer(current, ref, choice = "allow") } }, enabled = enabled, wide = true)
                        PlainButton("Deny", { model.launch { answer(current, ref, choice = "deny") } }, enabled = enabled, wide = true)
                    }
                }
                else -> {
                    val questions = current.questions
                    if (!questions.isNullOrEmpty()) {
                        questions.forEach { item -> QuestionField(item, questions.size > 1, answers, enabled) }
                    } else if (current.options.isNotEmpty()) {
                        current.options.forEach { option ->
                            OptionRow(option, chosen = choice == option.id, enabled = enabled) { choice = option.id }
                        }
                    } else {
                        Field(text, { text = it }, "Your answer", singleLine = false, maxLines = 8, enabled = enabled,
                            modifier = Modifier.semantics { contentDescription = "Your answer" })
                    }
                    Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PlainButton("Not now", dismiss, Modifier.weight(1f), wide = true)
                        ActionButton(
                            "Send answer",
                            {
                                val picked = answers.toMap()
                                model.launch {
                                    when {
                                        !current.questions.isNullOrEmpty() -> answer(current, ref, answers = picked)
                                        current.options.isNotEmpty() -> answer(current, ref, choice = choice)
                                        else -> answer(current, ref, text = text)
                                    }
                                }
                            },
                            Modifier.weight(1f), enabled = enabled && ready(current, answers, choice, text), wide = true,
                        )
                    }
                }
            }
            if (!current.supported || !model.mayAnswer(ref.hostID) || current.kind == "permission") PlainButton("Not now", dismiss, wide = true)
            model.feedback?.let { Text(it, style = figtree(15), color = p.ink) }
        }
    }
}

private fun title(request: AgentRequest, thread: ThreadSummary): String {
    if (request.kind == "permission") {
        return if (request.context?.command != null) "Allow ${Words.provider(thread.providerId)} to run this command?"
        else "${Words.provider(thread.providerId)} is asking permission"
    }
    val questions = request.questions
    return if (questions != null && questions.size == 1) questions[0].question else request.text
}

// Allow once first, then the other allows, then deny and the rest.
private fun rank(choice: PermissionChoice): Int = when {
    choice.kind == "allow-once" -> 0
    choice.kind.startsWith("allow-") -> 1
    else -> 2
}

private fun ready(request: AgentRequest, answers: Map<String, QuestionAnswer>, choice: String?, text: String): Boolean {
    val questions = request.questions
    if (!questions.isNullOrEmpty()) {
        return questions.all { q ->
            // A required question this phone can't answer blocks sending; its reason says why.
            if (q.unavailableReason != null) return@all q.required == false
            val chosen = answers[q.id]?.optionIds?.isNotEmpty() == true
            val written = !answers[q.id]?.text.isNullOrBlank()
            q.required == false || chosen || written
        }
    }
    if (request.options.isNotEmpty()) return choice != null
    return text.isNotBlank()
}

@Composable
private fun ChoiceAction(option: PermissionChoice, send: () -> Unit, enabled: Boolean, primary: Boolean) {
    val p = LocalPalette.current
    androidx.compose.material3.Button(
        onClick = send, enabled = enabled, modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
        shape = RoundedCornerShape(14.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = if (primary) p.action else p.raised, contentColor = if (primary) p.actionInk else p.ink,
            disabledContainerColor = (if (primary) p.action else p.raised).copy(alpha = 0.5f),
            disabledContentColor = (if (primary) p.actionInk else p.ink).copy(alpha = 0.5f),
        ),
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(option.label, style = figtree(16, FontWeight.SemiBold))
            option.description?.let { Text(it, style = figtree(13)) }
        }
    }
}

@Composable
private fun OptionRow(option: RequestOption, chosen: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).background(p.raised, RoundedCornerShape(14.dp))
            .border(2.dp, if (chosen) p.accent else p.raised, RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick).semantics { selected = chosen }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(option.label, style = figtree(16, FontWeight.SemiBold), color = p.ink.copy(alpha = if (enabled) 1f else 0.5f))
            option.description?.let { Text(it, style = figtree(13), color = p.muted) }
        }
        if (chosen) Icon(Icons.Filled.Check, contentDescription = null, tint = p.accent)
    }
}

@Composable
private fun QuestionField(item: Question, showsTitle: Boolean, answers: MutableMap<String, QuestionAnswer>, enabled: Boolean) {
    val p = LocalPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (showsTitle) Text(item.question, style = figtree(16, FontWeight.SemiBold), color = p.ink)
        item.unavailableReason?.let { Text(it, style = figtree(13), color = p.muted) }
        item.options.forEach { option ->
            val chosen = answers[item.id]?.optionIds?.contains(option.id) == true
            OptionRow(option, chosen, enabled && item.unavailableReason == null) {
                val answer = answers[item.id] ?: QuestionAnswer()
                answers[item.id] = if (item.multiSelect) {
                    answer.copy(optionIds = if (chosen) answer.optionIds - option.id else answer.optionIds + option.id)
                } else {
                    QuestionAnswer(optionIds = if (chosen && item.required == false) emptyList() else listOf(option.id), text = null)
                }
            }
        }
        if (item.allowFreeText) {
            Field(
                answers[item.id]?.text ?: "",
                { value ->
                    val answer = answers[item.id] ?: QuestionAnswer()
                    answers[item.id] = answer.copy(
                        text = value,
                        optionIds = if (!item.multiSelect && value.isNotEmpty()) emptyList() else answer.optionIds,
                    )
                },
                "Write your own answer", singleLine = false, maxLines = 6, enabled = enabled,
                modifier = Modifier.semantics { contentDescription = "Your own answer to: ${item.question}" },
            )
        }
    }
}
