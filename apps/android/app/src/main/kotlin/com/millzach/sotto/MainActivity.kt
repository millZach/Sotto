package com.millzach.sotto

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.FocusThreads
import com.millzach.sotto.core.ThreadGroups
import com.millzach.sotto.core.ThreadRef
import com.millzach.sotto.ui.ComputerDetailScreen
import com.millzach.sotto.ui.ComputersScreen
import com.millzach.sotto.ui.DisplayPreferences
import com.millzach.sotto.ui.LocalPalette
import com.millzach.sotto.ui.NewThreadScreen
import com.millzach.sotto.ui.PairFlow
import com.millzach.sotto.ui.SettingsScreen
import com.millzach.sotto.ui.SottoTheme
import com.millzach.sotto.ui.ThreadScreen
import com.millzach.sotto.ui.ThreadsScreen
import com.millzach.sotto.ui.figtree

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The recent-apps view shows no thread content, as the iPhone obscures it while inactive.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        val model = (application as SottoApplication).model
        val preferences = DisplayPreferences(this)
        setContent {
            LaunchedEffect(preferences.dark) {
                val bars = if (preferences.dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
            SottoTheme(preferences) { Root(model, preferences) }
        }
    }
}

private enum class Tab { Threads, Computers, Settings }

// Pairing until this phone holds a computer, then Threads, Computers and Settings.
@Composable
private fun Root(model: AppModel, preferences: DisplayPreferences) {
    val p = LocalPalette.current
    val insets = Modifier.fillMaxSize().background(p.canvas).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
    if (model.computers.isEmpty()) {
        PairFlow(model, insets)
        return
    }
    var tab by rememberSaveable { mutableStateOf(Tab.Threads) }
    var thread by rememberSaveable(stateSaver = refSaver) { mutableStateOf<ThreadRef?>(null) }
    var computer by rememberSaveable { mutableStateOf<String?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }

    Box(insets) {
        when {
            model.adding -> AddComputer(model)
            creating -> NewThreadScreen(model, close = { creating = false }, opened = { thread = it; tab = Tab.Threads })
            thread != null -> ThreadScreen(model, thread!!) { thread = null }
            else -> Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f)) {
                    when (tab) {
                        Tab.Threads -> ThreadsScreen(model, open = { thread = it }, newThread = { creating = true })
                        Tab.Computers -> {
                            val open = computer
                            if (open != null) ComputerDetailScreen(model, open) { computer = null }
                            else ComputersScreen(model) { computer = it }
                        }
                        Tab.Settings -> SettingsScreen(preferences)
                    }
                }
                Tabs(model, tab) { tab = it; if (it != Tab.Computers) computer = null }
            }
        }
    }
}

// The open thread survives a configuration change; nothing about it is written to disk.
private val refSaver = androidx.compose.runtime.saveable.Saver<ThreadRef?, List<String>>(
    save = { ref -> ref?.let { listOf(it.hostID, it.threadID) } ?: emptyList() },
    restore = { saved -> if (saved.size == 2) ThreadRef(saved[0], saved[1]) else null },
)

@Composable
private fun Tabs(model: AppModel, tab: Tab, choose: (Tab) -> Unit) {
    val p = LocalPalette.current
    // Waiting requests across computers, and recent threads that finished out of sight (ADR-0046).
    val badge = ThreadGroups.waiting(model.lists).size + FocusThreads(model.lists, opened = model.selected).unreadFinishedCount
    val colors = NavigationBarItemDefaults.colors(
        selectedIconColor = p.accent, selectedTextColor = p.accent, indicatorColor = p.raised,
        unselectedIconColor = p.muted, unselectedTextColor = p.muted,
    )
    NavigationBar(containerColor = p.surface) {
        NavigationBarItem(
            selected = tab == Tab.Threads, onClick = { choose(Tab.Threads) }, colors = colors,
            icon = {
                BadgedBox(badge = { if (badge > 0) Badge(containerColor = p.danger) { Text("$badge") } }) {
                    Icon(Icons.AutoMirrored.Outlined.List, contentDescription = null)
                }
            },
            label = { Text("Threads", style = figtree(12)) },
        )
        NavigationBarItem(
            selected = tab == Tab.Computers, onClick = { choose(Tab.Computers) }, colors = colors,
            icon = { Icon(Icons.Outlined.Laptop, contentDescription = null) }, label = { Text("Computers", style = figtree(12)) },
        )
        NavigationBarItem(
            selected = tab == Tab.Settings, onClick = { choose(Tab.Settings) }, colors = colors,
            icon = { Icon(Icons.Outlined.Tune, contentDescription = null) }, label = { Text("Settings", style = figtree(12)) },
        )
    }
}

// Add computer, over the tabs. Cancel closes it; a code already spent still finishes pairing.
@Composable
private fun AddComputer(model: AppModel) {
    val p = LocalPalette.current
    BackHandler(enabled = !model.working) { model.closeAdding() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { model.closeAdding() }, enabled = !model.working,
                modifier = Modifier.semantics { contentDescription = "Cancel adding a computer" },
            ) { Text("Cancel", style = figtree(16), color = p.accent) }
        }
        PairFlow(model, Modifier.weight(1f))
    }
}
