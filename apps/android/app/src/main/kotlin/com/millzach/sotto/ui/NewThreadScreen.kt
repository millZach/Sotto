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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.FolderListing
import com.millzach.sotto.core.FolderResult
import com.millzach.sotto.core.ThreadRef
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

private enum class Step { Computer, Project, Folders, Options }

// Three choices: computer, project (or a folder on it), then that computer's model and options.
@Composable
fun NewThreadScreen(model: AppModel, close: () -> Unit, opened: (ThreadRef) -> Unit) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(Step.Computer) }
    var hostID by remember { mutableStateOf("") }
    var projectID by remember { mutableStateOf<String?>(null) }
    var folder by remember { mutableStateOf<FolderListing?>(null) }
    var modelID by remember { mutableStateOf("") }
    var effort by remember { mutableStateOf("") }
    var permissionID by remember { mutableStateOf("") }
    val busy = model.creatingHostID != null
    val models = model.creationModels(hostID)
    val chosenModel = models.firstOrNull { it.id == modelID }
    LaunchedEffect(Unit) { model.creationFeedback = null }

    fun resetOptions() {
        val chosen = model.creationModels(hostID).firstOrNull { it.id == modelID }
        effort = chosen?.let { model.initialCreationEffort(hostID, it) } ?: ""
        permissionID = chosen?.startingPermission ?: ""
    }
    fun chooseOptions() { modelID = model.initialCreationModelID(hostID); step = Step.Options; resetOptions() }
    fun back() {
        if (busy) return
        model.creationFeedback = null
        when (step) {
            Step.Computer -> close()
            Step.Project -> step = Step.Computer
            Step.Folders -> step = Step.Project
            Step.Options -> step = if (folder == null) Step.Project else Step.Folders
        }
    }
    BackHandler { back() }

    Column(Modifier.fillMaxSize().background(p.canvas).navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { if (step != Step.Computer) TextButton(onClick = { back() }, enabled = !busy) { Text("Back", style = figtree(16), color = p.accent) } }
            Text("New thread", style = figtree(17, FontWeight.SemiBold), color = p.ink)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                TextButton(onClick = close, enabled = !busy) { Text("Cancel", style = figtree(16), color = p.accent) }
            }
        }
        when (step) {
            Step.Computer -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(22.dp)) {
                StepHeading("1 of 3", "Where should it run?")
                model.computers.forEach { computer ->
                    Choice(computer.name, model.status(computer.hostID).words, Icons.Outlined.Laptop, enabled = model.online(computer.hostID)) {
                        hostID = computer.hostID; projectID = null; folder = null; step = Step.Project
                    }
                    Hairline()
                }
                if (model.computers.none { model.online(it.hostID) }) {
                    Text("Reconnect a computer in Computers before starting a thread.", style = figtree(16), color = p.muted, modifier = Modifier.padding(top = 20.dp))
                }
            }
            Step.Project -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(22.dp)) {
                StepHeading("2 of 3 · ${model.name(hostID)}", "Choose a project")
                ConnectionNotice(model, hostID)
                model.projects(hostID).forEach { project ->
                    Choice(project.title, project.path, Icons.Outlined.Folder, enabled = model.online(hostID)) {
                        projectID = project.id; folder = null; chooseOptions()
                    }
                    Hairline()
                }
                Choice("Browse another folder", "Folders on ${model.name(hostID)}", Icons.Outlined.CreateNewFolder, enabled = model.canBrowseFolders(hostID), accent = true) {
                    step = Step.Folders
                }
                if (!model.canBrowseFolders(hostID) && model.online(hostID)) {
                    Text("Update Sotto on this computer to browse its folders.", style = figtree(14), color = p.muted, modifier = Modifier.padding(top = 12.dp))
                }
            }
            Step.Folders -> FolderPicker(model, hostID, folder?.path, Modifier.weight(1f)) { value ->
                folder = value; projectID = null; chooseOptions()
            }
            Step.Options -> {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(22.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                    StepHeading("3 of 3 · ${model.name(hostID)}", folder?.projectName ?: model.projects(hostID).firstOrNull { it.id == projectID }?.title ?: "Project")
                    ConnectionNotice(model, hostID)
                    (folder?.path ?: model.projects(hostID).firstOrNull { it.id == projectID }?.path)?.let {
                        SelectionContainer { Text(it, style = figtree(13), color = p.muted) }
                    }
                    if (models.isEmpty()) {
                        Text("No ready models on this computer. Connect a provider in Sotto there, then try again.", style = figtree(16), color = p.muted)
                    } else {
                        Picker(
                            "Model",
                            chosenModel?.let { "${Words.provider(it.providerId)} · ${it.name}" } ?: "Saved model unavailable — choose a model",
                            models.map { Triple(it.id, "${Words.provider(it.providerId)} · ${it.name}", true) },
                        ) { modelID = it; resetOptions() }
                        val efforts = chosenModel?.reasoningEfforts
                        if (!efforts.isNullOrEmpty()) {
                            Picker("Effort", effort.replaceFirstChar { it.uppercase() }, efforts.map { Triple(it, it.replaceFirstChar { c -> c.uppercase() }, true) }) { effort = it }
                        }
                        if (chosenModel != null) {
                            val permissions = chosenModel.permissions
                            Picker(
                                "Permissions",
                                permissions.firstOrNull { it.id == permissionID }?.name ?: "Choose a permission mode",
                                permissions.map { Triple(it.id, it.name, !it.grants || model.mayAnswer(hostID)) },
                            ) { permissionID = it }
                            permissions.firstOrNull { it.id == permissionID }?.asks?.let { Text(it, style = figtree(14), color = p.muted) }
                            if (permissions.isEmpty()) {
                                Text("This model has no supported permission modes. Choose another model.", style = figtree(16), color = p.muted)
                            } else if (!model.mayAnswer(hostID)) {
                                Text(
                                    "This phone can start a thread that asks before acting. To answer its permissions here, turn on Can answer in this computer’s Settings › Phones.",
                                    style = figtree(14), color = p.muted,
                                )
                            }
                        }
                    }
                    Text("Uses the project’s shared folder.", style = figtree(14), color = p.muted)
                    model.creationFeedback?.let { Text(it, style = figtree(16), color = p.warning) }
                    model.pendingCreations.filter { it.hostID == hostID }.forEach { CreationPendingRow(model, it) }
                }
                val permission = chosenModel?.permissions?.firstOrNull { it.id == permissionID }
                val canCreate = !busy && model.online(hostID) && model.pendingCreations.none { it.hostID == hostID } &&
                    permission != null && (!permission.grants || model.mayAnswer(hostID)) &&
                    (folder?.path != null || model.projects(hostID).any { it.id == projectID })
                Row(Modifier.fillMaxWidth().background(p.canvas).padding(horizontal = 22.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (busy) { CircularProgressIndicator(Modifier.size(20.dp), color = p.accent, strokeWidth = 2.dp); HGap(12.dp) }
                    ActionButton(
                        if (busy) "Opening thread…" else "Open thread on ${model.name(hostID)}",
                        {
                            scope.launch {
                                val ref = model.createThread(hostID, projectID, folder, modelID, effort, permissionID)
                                if (ref != null) { close(); opened(ref) }
                            }
                        },
                        Modifier.weight(1f), enabled = canCreate, wide = true,
                    )
                }
            }
        }
    }
}

@Composable
private fun StepHeading(step: String, title: String) {
    val p = LocalPalette.current
    Column(Modifier.padding(bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(step, style = figtree(13), color = p.muted)
        Text(title, style = figtree(25, FontWeight.SemiBold), color = p.ink, modifier = Modifier.semantics { heading() })
    }
}

@Composable
private fun ConnectionNotice(model: AppModel, hostID: String) {
    if (!model.online(hostID)) {
        Text("Can’t reach ${model.name(hostID)}. Reconnect before opening a thread.", style = figtree(16), color = LocalPalette.current.warning)
    }
}

@Composable
private fun Choice(title: String, detail: String?, icon: ImageVector, enabled: Boolean, accent: Boolean = false, onClick: () -> Unit) {
    val p = LocalPalette.current
    val alpha = if (enabled) 1f else 0.45f
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 64.dp).clickable(enabled = enabled, onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = p.accent.copy(alpha = alpha))
        HGap(12.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(title, style = figtree(17, FontWeight.SemiBold), color = (if (accent) p.accent else p.ink).copy(alpha = alpha))
            if (detail != null) Text(detail, style = figtree(13), color = p.muted.copy(alpha = alpha))
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.muted.copy(alpha = alpha))
    }
}

// A labelled menu: `options` are (id, words, may be chosen).
@Composable
private fun Picker(label: String, shown: String, options: List<Triple<String, String, Boolean>>, choose: (String) -> Unit) {
    val p = LocalPalette.current
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = figtree(13), color = p.muted)
        Box {
            Row(
                Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).background(p.surface, RoundedCornerShape(12.dp))
                    .border(1.dp, p.border, RoundedCornerShape(12.dp)).clickable { open = true }.padding(12.dp)
                    .semantics { contentDescription = "$label, $shown" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(shown, style = figtree(16), color = p.ink, modifier = Modifier.weight(1f))
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = p.muted)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = p.raised) {
                options.forEach { (id, words, allowed) ->
                    DropdownMenuItem(
                        text = { Text(words, style = figtree(16), color = p.ink.copy(alpha = if (allowed) 1f else 0.45f)) },
                        enabled = allowed, onClick = { open = false; choose(id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FolderPicker(model: AppModel, hostID: String, initialPath: String?, modifier: Modifier, selected: (FolderListing) -> Unit) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var listing by remember { mutableStateOf<FolderListing?>(null) }
    var filter by remember { mutableStateOf("") }
    var path by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableStateOf(Any()) }

    fun load(target: JsonElement?) {
        focus.clearFocus()
        val current = Any()
        request = current
        loading = true
        problem = null
        scope.launch {
            try {
                val result = model.folders(hostID, target)
                if (request !== current) return@launch
                when (result) {
                    is FolderResult.Listed -> { listing = result.listing; path = result.listing.path ?: ""; filter = "" }
                    FolderResult.Missing -> problem = "This folder doesn’t exist. Nothing was added. Go Home or enter another path."
                    FolderResult.Unreadable -> problem = "This folder can’t be read. Nothing was added. Go Home or choose another folder."
                }
            } catch (error: Exception) {
                if (request === current) problem = error.message
            } finally {
                if (request === current) loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load(initialPath?.let(::JsonPrimitive)) }

    Column(modifier) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Folders on ${model.name(hostID)}", style = figtree(23, FontWeight.SemiBold), color = p.ink, modifier = Modifier.semantics { heading() })
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { load(null) }) { Text("Home", style = figtree(16), color = p.accent) }
                TextButton(onClick = { load(JsonNull) }) { Text("All folders", style = figtree(16), color = p.accent) }
                Box(Modifier.weight(1f))
                val crumbs = listing?.crumbs
                if (crumbs != null && crumbs.size > 1) {
                    TextButton(
                        onClick = { load(crumbs[crumbs.size - 2].path?.let(::JsonPrimitive) ?: JsonNull) },
                        modifier = Modifier.semantics { contentDescription = "Open parent folder" },
                    ) { Text("Up", style = figtree(16), color = p.accent) }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Full folder path", style = figtree(13), color = p.muted)
                Field(
                    path, { path = it }, "Enter a folder path", mono = true,
                    keyboard = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Go),
                    actions = KeyboardActions(onGo = { if (path.isNotEmpty()) load(JsonPrimitive(path)) }),
                    modifier = Modifier.semantics { contentDescription = "Full folder path on ${model.name(hostID)}" },
                )
                TextButton(onClick = { load(JsonPrimitive(path)) }, enabled = path.isNotEmpty()) { Text("Go to folder", style = figtree(16), color = p.accent) }
            }
            Field(
                filter, { filter = it }, "Filter folders",
                keyboard = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
                actions = KeyboardActions(onDone = { focus.clearFocus() }),
                modifier = Modifier.semantics { contentDescription = "Filter folders in this directory" },
            )
            if (loading) Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), color = p.accent, strokeWidth = 2.dp)
                Text("  Reading folders…", style = figtree(15), color = p.muted)
            }
            problem?.let { Text(it, style = figtree(16), color = p.warning) }
            val shown = listing
            if (shown != null && !loading && problem == null) {
                SelectionContainer { Text(shown.path ?: "Drives", style = figtree(13), color = p.muted) }
                Column {
                    shown.folders.filter { filter.isEmpty() || it.name.contains(filter, ignoreCase = true) }.forEach { item ->
                        Row(
                            Modifier.fillMaxWidth().defaultMinSize(minHeight = 54.dp).clickable { load(JsonPrimitive(item.path)) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Folder, contentDescription = null, tint = p.accent)
                            HGap(12.dp)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(item.name, style = figtree(16), color = p.ink)
                                if (item.git) Text("Git repository", style = figtree(12), color = p.muted)
                            }
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.muted)
                        }
                        Hairline()
                    }
                }
                if (shown.folders.isEmpty()) Text("No subfolders here.", style = figtree(16), color = p.muted)
                if (shown.truncated) Text("Only the first 1,000 folders are listed. Enter a full path to open another.", style = figtree(14), color = p.muted)
            }
        }
        ActionButton(
            "Use this folder", { listing?.let(selected) },
            Modifier.padding(horizontal = 22.dp, vertical = 12.dp),
            enabled = !loading && problem == null && listing?.path != null && model.online(hostID), wide = true,
        )
    }
}
