package com.millzach.sotto.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

// Phone-only display preferences, saved on this phone. Nothing here changes any computer's settings.
@Composable
fun SettingsScreen(preferences: DisplayPreferences) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().background(p.canvas).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(top = 12.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(30.dp),
    ) {
        Text("Settings", style = figtree(32, FontWeight.Bold), color = p.ink)
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Heading("Appearance")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AppearanceChoice("Dark", Palette.dark, preferences.dark, Modifier.weight(1f)) { preferences.chooseDark(true) }
                AppearanceChoice("Light", Palette.light, !preferences.dark, Modifier.weight(1f)) { preferences.chooseDark(false) }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Heading("Reading")
            Hairline()
            Row(Modifier.fillMaxWidth().clickable { preferences.chooseLargerText(!preferences.largerText) }, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("Larger text", style = figtree(17), color = p.ink)
                    Text("Increase text size throughout Sotto.", style = figtree(14), color = p.muted)
                }
                Switch(
                    checked = preferences.largerText, onCheckedChange = { preferences.chooseLargerText(it) },
                    colors = SwitchDefaults.colors(checkedTrackColor = p.accent, checkedThumbColor = p.actionInk),
                )
            }
            Hairline()
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = figtree(14, FontWeight.SemiBold), color = LocalPalette.current.muted, modifier = Modifier.semantics { heading() })
}

@Composable
private fun AppearanceChoice(title: String, preview: Palette, chosen: Boolean, modifier: Modifier, choose: () -> Unit) {
    val p = LocalPalette.current
    Column(
        modifier.background(if (chosen) p.accent.copy(alpha = 0.12f) else p.surface, RoundedCornerShape(17.dp))
            .border(1.dp, if (chosen) p.accent else p.border, RoundedCornerShape(17.dp))
            .clickable(onClick = choose).semantics { selected = chosen }.padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(76.dp).background(preview.surface, RoundedCornerShape(9.dp)).padding(14.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(width = 70.dp, height = 7.dp).background(preview.muted, CircleShape))
                Box(Modifier.size(width = 45.dp, height = 5.dp).background(preview.muted, CircleShape))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = figtree(16), color = p.ink, modifier = Modifier.weight(1f))
            Icon(
                if (chosen) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, contentDescription = null,
                tint = if (chosen) p.accent else p.muted, modifier = Modifier.width(22.dp),
            )
        }
    }
}
