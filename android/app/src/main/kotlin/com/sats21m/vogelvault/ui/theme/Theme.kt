package com.sats21m.vogelvault.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Graphite Ledger Cockpit — Android.
 *
 * Same design language as the Linux client, which Victor approved on 2026-07-26.
 * The rules are not negotiable:
 *   - True-black canvas (#050505), warm cream text (#F5F2EA).
 *   - Orange is an ACCENT ONLY — never a text colour, never a body fill. It marks
 *     Bitcoin-owned surfaces, the selected nav item, and focus.
 *   - Bitcoin is not "crypto". No altcoin, leverage or speculation motifs.
 *   - Data density over decoration.
 *
 * There is no light theme. A ledger read in the dark is the whole point, and a
 * half-considered light variant would be worse than none.
 */

val VaultBlack = Color(0xFF050505)
val VaultSurface = Color(0xFF0C0C0D)
val VaultSurfaceRaised = Color(0xFF141416)
val VaultSurfaceSunken = Color(0xFF08080A)

val VaultCream = Color(0xFFF5F2EA)
val VaultTextMuted = Color(0xFFA3A09A)
val VaultTextDim = Color(0xFF7C7974)

val VaultLine = Color(0xFF1F1F22)
val VaultLineStrong = Color(0xFF2E2E33)

/** Sats/terminal orange. Accent only. */
val VaultAccent = Color(0xFFFF9F0A)
val VaultAccentDim = Color(0x29FF9F0A)

/** Bitcoin brand orange. Reserved for Bitcoin glyphs and Bitcoin-owned icons. */
val VaultBitcoin = Color(0xFFF7931A)

/** Non-Bitcoin navigation chrome. Never use this as a data-status signal. */
val VaultNavSlate = Color(0xFF7A86C0)

val VaultPositive = Color(0xFF4ADE80)
val VaultNegative = Color(0xFFF87171)
val VaultWarning = Color(0xFFFBBF24)
val VaultInfo = Color(0xFF7DD3FC)

private val VaultColorScheme = darkColorScheme(
    primary = VaultAccent,
    onPrimary = VaultBlack,
    primaryContainer = VaultAccentDim,
    onPrimaryContainer = VaultCream,
    secondary = VaultTextMuted,
    onSecondary = VaultBlack,
    background = VaultBlack,
    onBackground = VaultCream,
    surface = VaultSurface,
    onSurface = VaultCream,
    surfaceVariant = VaultSurfaceRaised,
    onSurfaceVariant = VaultTextMuted,
    surfaceContainerLowest = VaultBlack,
    surfaceContainerLow = VaultSurface,
    surfaceContainer = VaultSurface,
    surfaceContainerHigh = VaultSurfaceRaised,
    surfaceContainerHighest = VaultSurfaceRaised,
    inverseSurface = VaultSurfaceRaised,
    inverseOnSurface = VaultCream,
    inversePrimary = VaultAccent,
    outline = VaultLineStrong,
    outlineVariant = VaultLine,
    scrim = VaultBlack,
    error = VaultNegative,
    onError = VaultBlack,
)

/**
 * Monospace for every figure.
 *
 * Tabular alignment is what makes a ledger readable. DepartureMono is Victor's
 * terminal face but is not bundled here, so this falls back to the platform
 * monospace rather than shipping a font file into the APK.
 */
val LedgerNumeral = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontWeight = FontWeight.Medium,
    textAlign = TextAlign.End,
)

private val VaultTypography = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
    titleMedium = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
    bodyMedium = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Normal),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.8.sp),
)

/** Spacing on a 4dp rhythm, matching the Linux client's tokens. */
object VaultSpace {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
}

/** The active app root. A fresh app is deterministically Terminal Ledger. */
@Composable
fun LedgerTheme(
    treatment: LedgerTreatment = LedgerTreatment.TERMINAL_DARK,
    effectSettings: LedgerEffectSettings = LedgerEffectSettings(),
    accessibility: LedgerAccessibilityPreferences = LedgerAccessibilityPreferences(),
    content: @Composable () -> Unit,
) {
    SovereignLedgerTheme(
        treatment = treatment,
        effectSettings = effectSettings,
        accessibility = accessibility,
        content = content,
    )
}

/** Legacy test and preview wrapper. The shipped app root uses [LedgerTheme]. */
@Composable
fun VogelVaultTheme(content: @Composable () -> Unit) {
    // isSystemInDarkTheme is read but intentionally ignored: there is one theme.
    @Suppress("UNUSED_EXPRESSION")
    isSystemInDarkTheme()

    MaterialTheme(
        colorScheme = VaultColorScheme,
        typography = VaultTypography,
    ) {
        CompositionLocalProvider(
            LocalContentColor provides MaterialTheme.colorScheme.onBackground,
            content = content,
        )
    }
}
