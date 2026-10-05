package com.millzach.sotto.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.ComputerStatus
import kotlinx.coroutines.launch

// Add computer first, then every paired computer and whether it can be reached.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputersScreen(model: AppModel, openComputer: (String) -> Unit) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(p.canvas)) {
        Text("Computers", style = figtree(32, FontWeight.Bold), color = p.ink, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp))
        PullToRefreshBox(refreshing, { scope.launch { refreshing = true; model.refresh(); refreshing = false } }, Modifier.weight(1f)) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                ActionButton("+  Add computer", { model.startAdding() }, enabled = model.storageReady, wide = true)
                FeedbackBanner(model)
                Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(16.dp))) {
                    model.computers.forEachIndexed { index, computer ->
                        if (index > 0) Hairline(Modifier.padding(start = 38.dp))
                        Row(
                            Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp).clickable { openComputer(computer.hostID) }
                                .padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ComputerDot(model.status(computer.hostID), 10.dp)
                            Text("   ${computer.name}", style = figtree(17, FontWeight.SemiBold), color = p.ink, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(model.status(computer.hostID).words, style = figtree(16), color = p.muted)
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.muted)
                        }
                    }
                }
                Text("Whether this phone can answer questions and permissions is set in Sotto on each computer.", style = figtree(13), color = p.muted)
            }
        }
    }
}

// One computer: whether it can be reached, its names, whether this phone may answer there and how to allow
// it, this phone's client ID, Rename and Remove.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputerDetailScreen(model: AppModel, hostID: String, close: () -> Unit) {
    val p = LocalPalette.current
    val computer = model.computer(hostID)
    LaunchedEffect(computer == null) { if (computer == null) close() }
    BackHandler(onBack = close)
    if (computer == null) return
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    val status = model.status(hostID)
    Column(Modifier.fillMaxSize().background(p.canvas)) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to computers", tint = p.ink) }
            Text(computer.name, style = figtree(17, FontWeight.SemiBold), color = p.ink, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Box(Modifier.size(48.dp))
        }
        PullToRefreshBox(refreshing, { scope.launch { refreshing = true; model.connect(hostID); refreshing = false } }, Modifier.weight(1f)) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                StatusCard(model, hostID, status)
                FeedbackBanner(model)
                Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(16.dp))) {
                    DetailRow("Name on tailnet", computer.machineName, mono = true)
                    Hairline()
                    DetailRow("Address", computer.endpoint?.address ?: computer.address, mono = true)
                    Hairline()
                    DetailRow("Answers from this phone", answers(model, hostID, status), mono = false)
                    Hairline()
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Text("Client ID", style = figtree(16), color = p.ink)
                        SelectionContainer { Text(computer.pairing.clientId, style = figtree(14).copy(fontFamily = FontFamily.Monospace), color = p.muted) }
                    }
                }
                if (status == ComputerStatus.Online && !model.mayAnswer(hostID)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("To answer questions and permissions from this phone, open Sotto on ${computer.name}, go to Settings › Phones and turn on Can answer for this phone.", style = figtree(15), color = p.muted)
                        Text("On a host without a screen, run its --allow-answers command with this phone’s client ID.", style = figtree(15), color = p.muted)
                    }
                }
                Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(16.dp))) {
                    Text(
                        "Rename", style = figtree(17), color = p.ink,
                        modifier = Modifier.fillMaxWidth().clickable { newName = computer.localName ?: ""; renaming = true }
                            .padding(horizontal = 16.dp, vertical = 14.dp).semantics { contentDescription = "Rename ${computer.name} on this phone" },
                    )
                    Hairline()
                    Text(
                        if (model.removing == hostID) "Removing…" else "Remove this computer", style = figtree(17), color = p.danger,
                        modifier = Modifier.fillMaxWidth().clickable(enabled = model.removing == null) { confirmRemove = true }
                            .padding(horizontal = 16.dp, vertical = 14.dp).semantics { contentDescription = "Remove ${computer.name} from this phone" },
                    )
                }
                Text("Removing it forgets this phone on ${computer.name} too, when it can be reached. Threads stay on the computer.", style = figtree(13), color = p.muted)
            }
        }
    }
    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text("Remove ${computer.name}?") },
            text = { Text("This phone stops showing its threads. If ${computer.name} can’t be reached, remove this phone there too: in Settings › Phones, or with a host’s --revoke-client command.") },
            confirmButton = { TextButton(onClick = { confirmRemove = false; scope.launch { model.remove(hostID) } }) { Text("Remove from this phone", color = p.danger) } },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
            containerColor = p.surface,
        )
    }
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename ${computer.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("The name shows on this phone only. Leave it empty to use the computer’s own name.")
                    Field(newName, { newName = it }, "Name")
                }
            },
            confirmButton = { TextButton(onClick = { model.rename(hostID, newName); renaming = false }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
            containerColor = p.surface,
        )
    }
}

private fun answers(model: AppModel, hostID: String, status: ComputerStatus) = when (status) {
    ComputerStatus.Online -> if (model.mayAnswer(hostID)) "Allowed" else "Not allowed yet"
    ComputerStatus.Connecting -> "Checking…"
    ComputerStatus.Unreachable -> "Shown once it’s back"
}

// Online, connecting, or can't be reached with what to do about it.
@Composable
private fun StatusCard(model: AppModel, hostID: String, status: ComputerStatus) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ComputerDot(status, 10.dp)
            Text("  ${status.words}", style = figtree(22, FontWeight.Bold), color = p.ink)
        }
        if (status == ComputerStatus.Unreachable) {
            Text(model.problem(hostID) ?: "Check that it’s on and that Tailscale is connected on this phone.", style = figtree(15), color = p.muted)
            Text("Work carries on there. Your drafts are kept.", style = figtree(15), color = p.muted)
            ActionButton("Reconnect", { scope.launch { model.connect(hostID) } },
                Modifier.semantics { contentDescription = "Reconnect to ${model.name(hostID)}" }, wide = true)
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String, mono: Boolean) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = figtree(16), color = p.ink)
        HGap(12.dp)
        SelectionContainer(Modifier.weight(1f)) {
            Text(
                value, style = if (mono) figtree(14).copy(fontFamily = FontFamily.Monospace) else figtree(16), color = p.muted,
                textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
