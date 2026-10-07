package com.millzach.sotto.ui

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import com.millzach.sotto.R

// Sotto's default palette, light and dark, as the iPhone's asset catalog holds it
// (src/shared/themes/palettes.ts converted from OKLCH to sRGB; every text pair at 4.5:1 or better).
data class Palette(
    val canvas: Color, val surface: Color, val raised: Color,
    val ink: Color, val muted: Color, val border: Color, val hairline: Color,
    val accent: Color, val action: Color, val actionInk: Color,
    val bubble: Color, val bubbleInk: Color,
    val warning: Color, val warningSurface: Color, val danger: Color,
) {
    companion object {
        val dark = Palette(
            canvas = Color(0xFF040507), surface = Color(0xFF090A0E), raised = Color(0xFF111316),
            ink = Color(0xFFF9FAFD), muted = Color(0xFFA0A5AE), border = Color(0xFF2A2F39), hairline = Color(0xFF181B20),
            accent = Color(0xFF47B8A9), action = Color(0xFF47B8A9), actionInk = Color(0xFF070F0E),
            bubble = Color(0xFF0C3B36), bubbleInk = Color(0xFFF9FAFD),
            warning = Color(0xFFFFB900), warningSurface = Color(0xFF3A301F), danger = Color(0xFFFF6467),
        )
        val light = Palette(
            canvas = Color(0xFFF9F8F5), surface = Color(0xFFFDFCF9), raised = Color(0xFFF2F0EC),
            ink = Color(0xFF221D17), muted = Color(0xFF68625B), border = Color(0xFFD5D0C8), hairline = Color(0xFFE6E2DD),
            accent = Color(0xFF007D74), action = Color(0xFF007D74), actionInk = Color(0xFFFDFCF9),
            bubble = Color(0xFFCFECE7), bubbleInk = Color(0xFF221D17),
            warning = Color(0xFFB64B00), warningSurface = Color(0xFFF7EFE3), danger = Color(0xFFC10007),
        )
    }
}

val LocalPalette = staticCompositionLocalOf { Palette.dark }

val Figtree = FontFamily(
    Font(R.font.figtree_regular, FontWeight.Normal),
    Font(R.font.figtree_semibold, FontWeight.SemiBold),
    Font(R.font.figtree_semibold, FontWeight.Medium),
    Font(R.font.figtree_bold, FontWeight.Bold),
)

fun figtree(size: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(fontFamily = Figtree, fontSize = size.sp, fontWeight = weight)

// Phone-only display preferences. Nothing here is sent to a paired computer.
class DisplayPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("sotto.display", Context.MODE_PRIVATE)
    var dark by mutableStateOf(prefs.getString("phoneAppearance", "dark") != "light")
        private set
    var largerText by mutableStateOf(prefs.getBoolean("phoneLargerText", false))
        private set

    fun chooseDark(value: Boolean) {
        dark = value
        prefs.edit().putString("phoneAppearance", if (value) "dark" else "light").apply()
    }

    fun chooseLargerText(value: Boolean) {
        largerText = value
        prefs.edit().putBoolean("phoneLargerText", value).apply()
    }
}

@Composable
fun SottoTheme(preferences: DisplayPreferences, content: @Composable () -> Unit) {
    val palette = if (preferences.dark) Palette.dark else Palette.light
    val scheme = if (preferences.dark) {
        darkColorScheme(
            primary = palette.accent, onPrimary = palette.actionInk, background = palette.canvas, onBackground = palette.ink,
            surface = palette.surface, onSurface = palette.ink, surfaceVariant = palette.raised, onSurfaceVariant = palette.muted,
            outline = palette.border, outlineVariant = palette.hairline, error = palette.danger,
            surfaceContainer = palette.surface, surfaceContainerHigh = palette.raised, surfaceContainerLow = palette.surface,
        )
    } else {
        lightColorScheme(
            primary = palette.accent, onPrimary = palette.actionInk, background = palette.canvas, onBackground = palette.ink,
            surface = palette.surface, onSurface = palette.ink, surfaceVariant = palette.raised, onSurfaceVariant = palette.muted,
            outline = palette.border, outlineVariant = palette.hairline, error = palette.danger,
            surfaceContainer = palette.surface, surfaceContainerHigh = palette.raised, surfaceContainerLow = palette.surface,
        )
    }
    val base = Typography()
    val typography = Typography(
        bodyLarge = base.bodyLarge.copy(fontFamily = Figtree), bodyMedium = base.bodyMedium.copy(fontFamily = Figtree),
        bodySmall = base.bodySmall.copy(fontFamily = Figtree), titleLarge = base.titleLarge.copy(fontFamily = Figtree),
        titleMedium = base.titleMedium.copy(fontFamily = Figtree), titleSmall = base.titleSmall.copy(fontFamily = Figtree),
        labelLarge = base.labelLarge.copy(fontFamily = Figtree), labelMedium = base.labelMedium.copy(fontFamily = Figtree),
        labelSmall = base.labelSmall.copy(fontFamily = Figtree), headlineSmall = base.headlineSmall.copy(fontFamily = Figtree),
    )
    // Larger text raises the minimum; it never shrinks a larger system font size.
    val density = LocalDensity.current
    val scaled = if (preferences.largerText) Density(density.density, maxOf(density.fontScale, 1.3f)) else density
    CompositionLocalProvider(LocalPalette provides palette, LocalDensity provides scaled) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
