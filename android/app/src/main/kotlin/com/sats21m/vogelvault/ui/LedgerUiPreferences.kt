package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.theme.LedgerAccessibilityPreferences
import com.sats21m.vogelvault.ui.theme.LedgerEffectSettings
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

enum class LedgerAppearance(val storageKey: String, val label: String) {
    SYSTEM("system", "System"),
    TERMINAL("terminal", "Terminal"),
    DAYLIGHT("daylight", "Daylight");

    companion object {
        fun fromStorageKey(value: String?): LedgerAppearance =
            entries.firstOrNull { it.storageKey == value } ?: SYSTEM
    }
}

data class LedgerUiSettings(
    val appearance: LedgerAppearance = LedgerAppearance.SYSTEM,
    val scanlinesEnabled: Boolean = true,
    val phosphorGlowEnabled: Boolean = true,
    val reduceMotion: Boolean = false,
    val reduceTransparency: Boolean = false,
) {
    fun treatment(systemDark: Boolean): LedgerTreatment = when (appearance) {
        LedgerAppearance.SYSTEM -> if (systemDark) LedgerTreatment.TERMINAL_DARK else LedgerTreatment.DAYLIGHT_LIGHT
        LedgerAppearance.TERMINAL -> LedgerTreatment.TERMINAL_DARK
        LedgerAppearance.DAYLIGHT -> LedgerTreatment.DAYLIGHT_LIGHT
    }

    val effectSettings: LedgerEffectSettings
        get() = LedgerEffectSettings(scanlinesEnabled, phosphorGlowEnabled)

    val accessibility: LedgerAccessibilityPreferences
        get() = LedgerAccessibilityPreferences(reduceMotion, reduceTransparency)
}

internal class LedgerUiPreferences(private val preferences: SharedPreferences) {
    constructor(context: Context) : this(
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE),
    )

    fun current(): LedgerUiSettings = LedgerUiSettings(
        appearance = LedgerAppearance.fromStorageKey(preferences.getString(KEY_APPEARANCE, null)),
        scanlinesEnabled = preferences.getBoolean(KEY_SCANLINES, true),
        phosphorGlowEnabled = preferences.getBoolean(KEY_PHOSPHOR, true),
        reduceMotion = preferences.getBoolean(KEY_REDUCE_MOTION, false),
        reduceTransparency = preferences.getBoolean(KEY_REDUCE_TRANSPARENCY, false),
    )

    fun save(settings: LedgerUiSettings): Boolean = preferences.edit()
        .putString(KEY_APPEARANCE, settings.appearance.storageKey)
        .putBoolean(KEY_SCANLINES, settings.scanlinesEnabled)
        .putBoolean(KEY_PHOSPHOR, settings.phosphorGlowEnabled)
        .putBoolean(KEY_REDUCE_MOTION, settings.reduceMotion)
        .putBoolean(KEY_REDUCE_TRANSPARENCY, settings.reduceTransparency)
        .commit()

    private companion object {
        const val PREFERENCES_NAME = "ledger-ui-settings"
        const val KEY_APPEARANCE = "appearance"
        const val KEY_SCANLINES = "scanlines"
        const val KEY_PHOSPHOR = "phosphor_glow"
        const val KEY_REDUCE_MOTION = "reduce_motion"
        const val KEY_REDUCE_TRANSPARENCY = "reduce_transparency"
    }
}

/** Draw-only atmosphere. It never receives input or adds an accessibility node. */
@Composable
internal fun LedgerAtmosphere(modifier: Modifier = Modifier) {
    val effects = LocalLedgerEffects.current
    val colors = LocalLedgerTheme.current.colors
    if (!effects.showScanlines) return
    Canvas(modifier.fillMaxSize()) {
        drawScanlines(colors.scanline)
    }
}

private fun DrawScope.drawScanlines(color: androidx.compose.ui.graphics.Color) {
    val step = 3.dp.toPx()
    var y = 0f
    while (y < size.height) {
        drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
        y += step
    }
}
