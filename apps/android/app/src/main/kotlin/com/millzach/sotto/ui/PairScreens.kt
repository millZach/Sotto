package com.millzach.sotto.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.app.FoundHost
import com.millzach.sotto.core.PairingCode

// Adding a computer in two steps: find it by its name on the tailnet, then enter the code it shows.
// Full screen until one computer is paired; after that, Add computer over the tabs.
// Pairing admits this phone; whether it may answer permissions is decided on that computer.
@Composable
fun PairFlow(model: AppModel, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Box(modifier.fillMaxSize().background(p.canvas)) {
        val found = model.found
        if (found != null) CodeStep(model, found) else NameStep(model)
    }
}

@Composable
private fun StepHeader(step: Int, title: String, detail: String) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Step $step of 2", style = figtree(15), color = p.muted)
        Text(title, style = figtree(28, FontWeight.Bold), color = p.ink, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(detail, style = figtree(16), color = p.muted, textAlign = TextAlign.Center)
    }
}

@Composable
private fun PairFeedback(model: AppModel) {
    val feedback = model.pairFeedback ?: return
    Text(feedback, style = figtree(15), color = LocalPalette.current.warning, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun NameStep(model: AppModel) {
    val p = LocalPalette.current
    var name by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    fun find() { if (name.isNotBlank()) model.launch { find(name) } }
    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(top = 48.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            StepHeader(1, "Add computer", "Read its name in Sotto on that computer: Settings › Phones. For a host without a screen, use its name on your tailnet.")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Computer name on your tailnet", style = figtree(15, FontWeight.SemiBold), color = p.muted)
                Field(
                    value = name, onValueChange = { name = it }, placeholder = "forge",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                    actions = KeyboardActions(onNext = { find() }),
                    modifier = Modifier.focusRequester(focus).semantics { contentDescription = "Computer name on your tailnet" },
                )
            }
            PairFeedback(model)
        }
        ActionButton(
            if (model.working) "Finding it…" else "Next", { find() },
            Modifier.padding(horizontal = 24.dp, vertical = 12.dp).semantics {
                contentDescription = if (model.working) "Finding the computer" else "Find this computer"
            },
            enabled = !model.working && model.storageReady && name.isNotBlank(), wide = true,
        )
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

@Composable
private fun CodeStep(model: AppModel, found: FoundHost) {
    val p = LocalPalette.current
    var code by rememberSaveable { mutableStateOf("") }
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    fun pair() {
        if (code.length != PairingCode.LENGTH) return
        model.launch { pair(code) }
    }
    Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(top = 48.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            StepHeader(
                2, "Enter the pairing code",
                "In Sotto on ${found.name}: Settings › Phones › Pair a phone. A host without a screen prints one from its pairing command. A code works once, for five minutes.",
            )
            // The field takes the typing; the boxes show it. TalkBack reads the field.
            BasicTextField(
                value = code,
                onValueChange = { code = PairingCode.cleaned(it) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { pair() }),
                cursorBrush = SolidColor(p.accent.copy(alpha = 0f)),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused }
                    .semantics { contentDescription = "Pairing code" },
                decorationBox = { CodeBoxes(code, focused) },
            )
            FoundLine(model, found)
            PairFeedback(model)
        }
        ActionButton(
            if (model.working) "Pairing…" else "Pair", { pair() },
            Modifier.padding(horizontal = 24.dp, vertical = 12.dp).semantics {
                contentDescription = if (model.working) "Pairing" else "Pair with ${found.name}"
            },
            enabled = !model.working && code.length == PairingCode.LENGTH, wide = true,
        )
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

// Where step 1 found Sotto, with the way back to step 1.
@Composable
private fun FoundLine(model: AppModel, found: FoundHost) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
        Text(
            "  Found Sotto at ${found.endpoint.address}", style = figtree(15), color = p.muted,
            maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false),
        )
        TextButton(onClick = { model.changeComputer() }, enabled = !model.working,
            modifier = Modifier.semantics { contentDescription = "Change computer" }) {
            Text("Change", style = figtree(15, FontWeight.SemiBold), color = p.accent)
        }
    }
}

// Eight boxes in two groups of four, the way the computer shows a code.
@Composable
private fun CodeBoxes(code: String, focused: Boolean) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        for (index in 0 until PairingCode.LENGTH) {
            if (index == 4) Text("–", color = p.muted, modifier = Modifier.width(14.dp), textAlign = TextAlign.Center)
            val current = focused && index == minOf(code.length, PairingCode.LENGTH - 1)
            Box(
                Modifier.padding(horizontal = 2.5.dp).size(width = 34.dp, height = 50.dp)
                    .background(p.surface, RoundedCornerShape(10.dp))
                    .border(if (current) 2.dp else 1.dp, if (current) p.accent else p.border, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    code.getOrNull(index)?.toString() ?: " ", color = p.ink,
                    style = figtree(24, FontWeight.SemiBold).copy(fontFamily = FontFamily.Monospace, fontSize = 24.sp),
                )
            }
        }
    }
}
