package com.millzach.sotto.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.ComputerFilter
import com.millzach.sotto.core.ComputerStatus
import com.millzach.sotto.core.ComputerThreads
import com.millzach.sotto.core.FocusThreads
import com.millzach.sotto.core.HostedThread
import com.millzach.sotto.core.PendingOperation
import com.millzach.sotto.core.ThreadRef
import com.millzach.sotto.core.ThreadState
import kotlinx.coroutines.launch

// Focus reads only host list summaries. Opening a thread subscribes to its detail.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadsScreen(model: AppModel, open: (ThreadRef) -> Unit, newThread: () -> Unit) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var settledExpanded by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val groups = FocusThreads(model.lists, model.show, query, model.selected)
    Column(Modifier.fillMaxSize().background(p.canvas)) {
        Row(Modifier.fillMaxWidth().padding(start = 22.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Threads", style = figtree(32, FontWeight.Bold), color = p.ink, modifier = Modifier.weight(1f))
            IconButton(onClick = newThread) { Icon(Icons.Filled.Add, contentDescription = "New thread", tint = p.accent) }
        }
        Column(Modifier.padding(horizontal = 22.dp).padding(bottom = 8.dp)) {
            ComputerMenu(model)
            SearchPill(query) { query = it }
            Gap(12.dp)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = p.accent)) { append("${groups.working.size}") }
                    append(" working      ${groups.requestCount} ${if (groups.requestCount == 1) "needs" else "need"} you")
                },
                style = figtree(13), color = p.muted,
            )
        }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; model.refresh(); refreshing = false } },
            modifier = Modifier.weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 22.dp)) {
                item { FeedbackBanner(model, Modifier.padding(top = 8.dp)) }
                items(model.pendingCreations.filter { model.show.admits(it.hostID) }, key = { it.id }) {
                    CreationPendingRow(model, it, Modifier.padding(top = 12.dp))
                }
                items(model.lists.filter { model.show.admits(it.hostID) && it.status != ComputerStatus.Online }, key = { "note-" + it.hostID }) {
                    ConnectionNote(model, it)
                }
                if (groups.isEmpty) item {
                    Text(
                        when {
                            groups.searching -> "No matching threads."
                            model.anyConnecting -> "Reading threads…"
                            else -> "No threads here yet. Tap New thread to start one."
                        },
                        style = figtree(16), color = p.muted, modifier = Modifier.padding(vertical = 28.dp),
                    )
                }
                if (groups.questions.isNotEmpty()) {
                    item { SectionHeading("Needs your answer", groups.questions.size) }
                    items(groups.questions, key = { "q-" + it.id }) { row ->
                        QuestionRow(row, Modifier.padding(bottom = 10.dp).clickable { open(row.ref) })
                    }
                }
                if (groups.working.isNotEmpty()) {
                    item { SectionHeading("Working now", groups.working.size) }
                    items(groups.working, key = { "w-" + it.id }) { row ->
                        WorkingRow(row, Modifier.padding(bottom = 10.dp).clickable { open(row.ref) })
                    }
                }
                if (groups.recent.isNotEmpty()) {
                    item { SectionHeading("Recent", groups.recent.size) }
                    items(groups.recent, key = { "r-" + it.id }) { row ->
                        RecentRow(row, groups.isUnreadFinish(row), Modifier.clickable { open(row.ref) })
                        Hairline()
                    }
                }
                if (groups.settled.isNotEmpty()) {
                    if (groups.searching) {
                        item { SectionHeading("Settled", groups.settled.size) }
                    } else item {
                        Row(
                            Modifier.fillMaxWidth().padding(top = 16.dp).defaultMinSize(minHeight = 52.dp)
                                .clickable { settledExpanded = !settledExpanded }
                                .semantics {
                                    contentDescription = if (settledExpanded) "Hide settled threads" else "Show settled threads"
                                    stateDescription = "${groups.settled.size} threads, ${if (settledExpanded) "expanded" else "collapsed"}"
                                },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (settledExpanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = null, tint = p.muted,
                            )
                            Text(" Settled", style = figtree(15), color = p.muted, modifier = Modifier.weight(1f))
                            Text("${groups.settled.size}", style = figtree(15), color = p.muted)
                        }
                    }
                    if (settledExpanded || groups.searching) {
                        items(groups.settled, key = { "s-" + it.id }) { row ->
                            RecentRow(row, groups.isUnreadFinish(row), Modifier.clickable { open(row.ref) })
                            Hairline()
                        }
                    }
                }
                item { Gap(24.dp) }
            }
        }
    }
}

@Composable
private fun SearchPill(query: String, onChange: (String) -> Unit) {
    val p = LocalPalette.current
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).background(p.raised, CircleShape)
            .border(1.dp, if (focused) p.accent else p.hairline, CircleShape).padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = p.muted)
        HGap(10.dp)
        BasicTextField(
            value = query, onValueChange = onChange, singleLine = true,
            textStyle = figtree(16).copy(color = p.ink), cursorBrush = SolidColor(p.accent),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
            modifier = Modifier.weight(1f).semantics { contentDescription = "Search threads" }
                .onFocusChanged { focused = it.isFocused },
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text("Search threads", style = figtree(16), color = p.muted)
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) {
            IconButton(onClick = { onChange("") }) { Icon(Icons.Filled.Cancel, contentDescription = "Clear search", tint = p.muted) }
        } else {
            HGap(12.dp)
        }
    }
}

@Composable
private fun ComputerMenu(model: AppModel) {
    val p = LocalPalette.current
    var open by remember { mutableStateOf(false) }
    val show = model.show
    val title = if (show is ComputerFilter.Only) model.name(show.hostID) else "All computers"
    Box {
        Row(
            Modifier.defaultMinSize(minHeight = 44.dp).clickable { open = true }
                .semantics { contentDescription = "Choose a computer, $title" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (show is ComputerFilter.Only) ComputerDot(model.status(show.hostID), 6.dp)
            else Icon(Icons.Outlined.Laptop, contentDescription = null, tint = p.muted, modifier = Modifier.size(16.dp))
            Text("  $title ", style = figtree(14), color = p.muted)
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = p.muted, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = p.raised) {
            DropdownMenuItem(text = { Text("All computers", style = figtree(16), color = p.ink) }, onClick = { model.show = ComputerFilter.All; open = false })
            model.computers.forEach { computer ->
                DropdownMenuItem(
                    text = { Text("${computer.name} · ${model.status(computer.hostID).words}", style = figtree(16), color = p.ink) },
                    onClick = { model.show = ComputerFilter.Only(computer.hostID); open = false },
                )
            }
        }
    }
}

@Composable
private fun ConnectionNote(model: AppModel, computer: ComputerThreads) {
    val p = LocalPalette.current
    Column(Modifier.padding(top = 12.dp)) {
        Text(
            if (computer.status == ComputerStatus.Connecting) "Checking ${computer.name}…" else "Can’t reach ${computer.name}. Showing its last shared threads.",
            style = figtree(13), color = p.muted,
        )
        if (computer.status == ComputerStatus.Unreachable) {
            TextButton(onClick = { model.launch { connect(computer.hostID) } }) {
                Text("Reconnect to ${computer.name}", style = figtree(14), color = p.accent)
            }
        }
    }
}

@Composable
private fun Metadata(row: HostedThread) {
    Text(
        listOfNotNull(row.project, Words.provider(row.thread.providerId), row.computer).joinToString(" · "),
        style = figtree(12), color = LocalPalette.current.muted,
    )
}

@Composable
private fun Timestamp(row: HostedThread) {
    val summary = row.thread.summary
    Text(Words.ago(summary?.runningTurnStartedAt ?: summary?.lastMessageAt) ?: "", style = figtree(11), color = LocalPalette.current.muted)
}

@Composable
private fun StatusLine(row: HostedThread) {
    val p = LocalPalette.current
    val state = ThreadState.of(row.thread)
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (row.reachable) { StatusDot(state, 5.dp); HGap(6.dp) }
        Text(
            if (row.reachable) state.words else row.status.words, style = figtree(12),
            color = if (!row.reachable) p.muted else if (state == ThreadState.Failed) p.danger else p.accent,
        )
    }
}

@Composable
private fun QuestionRow(row: HostedThread, modifier: Modifier) {
    val p = LocalPalette.current
    val requests = row.thread.requests
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Min).background(p.warningSurface, RoundedCornerShape(topEnd = 14.dp, bottomEnd = 14.dp))) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(p.warning))
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Outlined.HelpOutline, contentDescription = null, tint = p.warning, modifier = Modifier.size(14.dp))
                Text(" Needs you", style = figtree(12), color = p.warning)
            }
            Text(row.thread.title, style = figtree(16, FontWeight.SemiBold), color = p.ink, maxLines = 3)
            requests.firstOrNull()?.let { Text(it.questions?.firstOrNull()?.question ?: it.text, style = figtree(15), color = p.muted, maxLines = 2) }
            Metadata(row)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        requests.size > 1 -> "Review ${requests.size} requests"
                        requests.firstOrNull()?.kind == "permission" -> "Review permission"
                        else -> "Review question"
                    },
                    style = figtree(14, FontWeight.SemiBold), color = p.warning, modifier = Modifier.weight(1f),
                )
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.warning)
            }
        }
    }
}

@Composable
private fun WorkingRow(row: HostedThread, modifier: Modifier) {
    val p = LocalPalette.current
    val state = ThreadState.of(row.thread)
    val description = when {
        state == ThreadState.Compacting -> "Making room in the thread’s context."
        state == ThreadState.Waiting -> "A background command is still running."
        row.thread.status != "running" && !row.thread.backgroundWork.isNullOrEmpty() -> "Background agents are still working."
        else -> "${Words.provider(row.thread.providerId)} is working on ${row.computer}."
    }
    Column(
        modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(17.dp)).border(1.dp, p.hairline, RoundedCornerShape(17.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { StatusLine(row) }
            Timestamp(row)
        }
        Text(row.thread.title, style = figtree(18, FontWeight.SemiBold), color = p.ink, maxLines = 3)
        Text(description, style = figtree(15), color = p.muted, maxLines = 2)
        Hairline(Modifier.padding(top = 3.dp))
        Metadata(row)
    }
}

@Composable
private fun RecentRow(row: HostedThread, unread: Boolean, modifier: Modifier) {
    val p = LocalPalette.current
    val state = ThreadState.of(row.thread)
    Column(
        modifier.fillMaxWidth().defaultMinSize(minHeight = 56.dp).padding(vertical = 14.dp)
            .semantics { if (unread) contentDescription = "${row.thread.title}, just finished, not opened yet" },
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.weight(1f)) {
                // The dot sits in the margin, outside the text column, so the row keeps its place and its width.
                if (unread) Box(Modifier.offset(x = (-15).dp, y = 6.dp).size(9.dp).background(p.accent, CircleShape))
                Text(row.thread.title, style = figtree(16, if (unread) FontWeight.Bold else FontWeight.SemiBold), color = p.ink, maxLines = 3)
            }
            HGap(12.dp)
            Timestamp(row)
        }
        if (unread) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(p.accent, CircleShape))
                Text("  Just finished", style = figtree(12), color = p.accent)
            }
        } else if (!row.reachable || state == ThreadState.Failed) {
            StatusLine(row)
        }
        Metadata(row)
    }
}

@Composable
fun CreationPendingRow(model: AppModel, operation: PendingOperation, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    var dismissing by remember { mutableStateOf(false) }
    Card(modifier) {
        Text(
            "${if (operation.kind == "create-project") "Project registration" else "Thread creation"} on ${model.name(operation.hostID)} is unconfirmed.",
            style = figtree(16, FontWeight.SemiBold), color = p.ink,
        )
        Text("Nothing was resent. Check this computer before trying again.", style = figtree(14), color = p.muted)
        PlainButton("Check again", { model.launch { checkDelivery(operation.hostID) } }, enabled = model.online(operation.hostID))
        TextButton(onClick = { dismissing = true }) { Text("Dismiss unconfirmed action", style = figtree(15), color = p.accent) }
    }
    if (dismissing) {
        AlertDialog(
            onDismissRequest = { dismissing = false },
            title = { Text("Dismiss this unconfirmed action?") },
            text = { Text("The computer may already have created it. Check its projects and threads first. Dismissing sends nothing.") },
            confirmButton = { TextButton(onClick = { model.acknowledgeUnknown(operation.id); dismissing = false }) { Text("Dismiss unconfirmed action") } },
            dismissButton = { TextButton(onClick = { dismissing = false }) { Text("Cancel") } },
            containerColor = p.surface,
        )
    }
}
