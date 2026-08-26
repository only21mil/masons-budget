package com.sats21m.vogelvault.ui.theme

import androidx.annotation.FontRes
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.sats21m.vogelvault.R
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

enum class LedgerTreatment { TERMINAL_DARK, DAYLIGHT_LIGHT }
enum class LedgerRuleStyle { SOLID, DASHED }

/** Keeps the handoff's OKLCH values in their authored color space. */
@Immutable
data class LedgerOklch(val lightness: Float, val chroma: Float, val hueDegrees: Float) {
    val color: Color
        get() {
            val radians = hueDegrees * PI.toFloat() / 180f
            return Color(
                lightness,
                chroma * cos(radians),
                chroma * sin(radians),
                1f,
                ColorSpaces.Oklab,
            )
        }
}

@Immutable
data class LedgerColors(
    val background: Color,
    val panel: Color,
    val panelRaised: Color,
    val line: Color,
    val lineSubtle: Color,
    val foreground: Color,
    val foregroundSecondary: Color,
    val foregroundTertiary: Color,
    val bitcoin: Color,
    val bitcoinSoft: Color,
    val gainSpec: LedgerOklch,
    val lossSpec: LedgerOklch,
    val scanline: Color,
    val knob: Color,
) {
    val gain: Color get() = gainSpec.color
    val loss: Color get() = lossSpec.color
}

object LedgerPalettes {
    val TerminalDark = LedgerColors(
        background = Color(0xFF0A0D0C),
        panel = Color(0xFF0C100E),
        panelRaised = Color(0xFF111614),
        line = Color(0xFFD6EEE0).copy(alpha = 0.10f),
        lineSubtle = Color(0xFFD6EEE0).copy(alpha = 0.06f),
        foreground = Color(0xFFE8EFE9),
        foregroundSecondary = Color(0xFFE8EFE9).copy(alpha = 0.56f),
        foregroundTertiary = Color(0xFFE8EFE9).copy(alpha = 0.36f),
        bitcoin = Color(0xFFF7931A),
        bitcoinSoft = Color(0xFFF7931A).copy(alpha = 0.12f),
        gainSpec = LedgerOklch(0.74f, 0.155f, 158f),
        lossSpec = LedgerOklch(0.70f, 0.155f, 28f),
        scanline = Color.White.copy(alpha = 0.022f),
        knob = Color(0xFFE8EFE9),
    )

    val DaylightLight = LedgerColors(
        background = Color(0xFFF4F3EE),
        panel = Color(0xFFEDEBE4),
        panelRaised = Color.White,
        line = Color(0xFF141715).copy(alpha = 0.14f),
        lineSubtle = Color(0xFF141715).copy(alpha = 0.08f),
        foreground = Color(0xFF141715),
        foregroundSecondary = Color(0xFF141715).copy(alpha = 0.60f),
        foregroundTertiary = Color(0xFF141715).copy(alpha = 0.42f),
        bitcoin = Color(0xFFC96A05),
        bitcoinSoft = Color(0xFFC96A05).copy(alpha = 0.10f),
        gainSpec = LedgerOklch(0.52f, 0.13f, 158f),
        lossSpec = LedgerOklch(0.52f, 0.15f, 28f),
        scanline = Color.Black.copy(alpha = 0.012f),
        knob = Color.White,
    )
}

/** Official variable font registered at handoff weights 300, 400, 500, 600, and 700. */
val SourceCodePro: FontFamily = FontFamily(
    sourceCodeProFont(FontWeight.Light),
    sourceCodeProFont(FontWeight.Normal),
    sourceCodeProFont(FontWeight.Medium),
    sourceCodeProFont(FontWeight.SemiBold),
    sourceCodeProFont(FontWeight.Bold),
)

private fun sourceCodeProFont(
    weight: FontWeight,
    @FontRes resource: Int = R.font.source_code_pro_variable,
): Font = Font(resource, weight, FontStyle.Normal)

/** Explicit even with a monospaced face, so figures keep the contract if the face changes. */
fun TextStyle.withLedgerTabularFigures(): TextStyle = copy(fontFeatureSettings = "tnum")

@Immutable
data class LedgerTypeTokens(
    val screenTitle: TextStyle,
    val drilldownTitle: TextStyle,
    val screenSubtitle: TextStyle,
    val heroNumeral: TextStyle,
    val priceHero: TextStyle,
    val priceHeroDecimals: TextStyle,
    val kpiLabel: TextStyle,
    val kpiValue: TextStyle,
    val kpiSub: TextStyle,
    val sectionLabel: TextStyle,
    val rowPrimary: TextStyle,
    val rowMeta: TextStyle,
    val rowFigure: TextStyle,
    val chip: TextStyle,
    val tabLabel: TextStyle,
    val tabGlyphSize: TextUnit,
    val body: TextStyle,
    val button: TextStyle,
    val amountInput: TextStyle,
    val textInput: TextStyle,
)

private fun ledgerTypeTokens(treatment: LedgerTreatment): LedgerTypeTokens {
    val daylight = treatment == LedgerTreatment.DAYLIGHT_LIGHT
    fun style(
        size: TextUnit,
        weight: FontWeight,
        tracking: TextUnit = TextUnit.Unspecified,
        lineHeight: TextUnit = TextUnit.Unspecified,
        tabular: Boolean = false,
    ): TextStyle {
        val base = TextStyle(
            fontFamily = SourceCodePro,
            fontSize = size,
            fontWeight = weight,
            letterSpacing = tracking,
            lineHeight = lineHeight,
        )
        return if (tabular) base.withLedgerTabularFigures() else base
    }

    return LedgerTypeTokens(
        screenTitle = style(if (daylight) 29.sp else 26.sp, FontWeight.SemiBold, (-0.02).em),
        drilldownTitle = style(24.sp, FontWeight.SemiBold, (-0.02).em, 27.6.sp),
        screenSubtitle = style(9.5.sp, FontWeight.Normal, 0.18.em),
        heroNumeral = style(28.sp, FontWeight.SemiBold, (-0.03).em, tabular = true),
        priceHero = style(38.sp, FontWeight.SemiBold, (-0.03).em, tabular = true),
        priceHeroDecimals = style(20.sp, FontWeight.SemiBold, (-0.03).em, tabular = true),
        kpiLabel = style(9.sp, FontWeight.Medium, 0.16.em),
        kpiValue = style(20.sp, FontWeight.Medium, tabular = true),
        kpiSub = style(9.sp, FontWeight.Normal, 0.06.em),
        sectionLabel = style(9.5.sp, FontWeight.SemiBold, 0.18.em),
        rowPrimary = style(if (daylight) 13.5.sp else 12.5.sp, FontWeight.Normal),
        rowMeta = style(9.5.sp, FontWeight.Normal, 0.05.em),
        rowFigure = style(if (daylight) 13.5.sp else 12.5.sp, FontWeight.Medium, tabular = true),
        chip = style(10.5.sp, FontWeight.SemiBold, 0.08.em),
        tabLabel = style(8.5.sp, FontWeight.SemiBold, 0.10.em),
        tabGlyphSize = 17.sp,
        body = style(10.5.sp, FontWeight.Normal, lineHeight = 19.425.sp),
        button = style(11.sp, FontWeight.SemiBold, 0.10.em),
        amountInput = style(28.sp, FontWeight.Medium, tabular = true),
        textInput = style(15.sp, FontWeight.Normal),
    )
}

@Immutable
data class LedgerDensityTokens(
    val screenGutter: Dp,
    val cardPadding: Dp,
    val rowVerticalPadding: Dp,
    val denseRowVerticalPadding: Dp,
    val categoryRowVerticalPadding: Dp,
    val sectionTopSpace: Dp,
    val sectionLabelBottomSpace: Dp,
    val chipGap: Dp,
    val actionGap: Dp,
    val minimumHitTarget: Dp,
    val ruleStyle: LedgerRuleStyle,
)

object LedgerSpacing {
    val xSmall = 4.dp
    val small = 6.dp
    val medium = 9.dp
    val large = 12.dp
    val xLarge = 20.dp
    val section = 22.dp
}

object LedgerRadii {
    val control = 3.dp
    val card = 4.dp
    val toggleTrack = 12.dp
    const val statusDotPercent = 50
}

object LedgerMotion {
    const val chipAndNavigationMillis = 160
    const val toggleCheckboxAndButtonMillis = 180
    const val toggleKnobMillis = 200
    const val progressAndThemeMillis = 300
    const val onboardingCursorBlinkMillis = 1_100
}

@Immutable
data class LedgerAccessibilityPreferences(
    val reduceMotion: Boolean = false,
    val reduceTransparency: Boolean = false,
)

@Immutable
data class LedgerEffectSettings(
    val scanlinesEnabled: Boolean = true,
    val phosphorGlowEnabled: Boolean = true,
)

@Immutable
data class LedgerResolvedEffects(
    val showScanlines: Boolean,
    val showPhosphorGlow: Boolean,
    val animate: Boolean,
)

fun LedgerEffectSettings.resolve(
    accessibility: LedgerAccessibilityPreferences,
): LedgerResolvedEffects {
    val suppressTexture = accessibility.reduceMotion || accessibility.reduceTransparency
    return LedgerResolvedEffects(
        showScanlines = scanlinesEnabled && !suppressTexture,
        showPhosphorGlow = phosphorGlowEnabled && !suppressTexture,
        animate = !accessibility.reduceMotion,
    )
}

@Immutable
data class LedgerThemeTokens(
    val treatment: LedgerTreatment,
    val colors: LedgerColors,
    val type: LedgerTypeTokens,
    val density: LedgerDensityTokens,
)

private fun themeTokens(treatment: LedgerTreatment): LedgerThemeTokens {
    val daylight = treatment == LedgerTreatment.DAYLIGHT_LIGHT
    return LedgerThemeTokens(
        treatment = treatment,
        colors = if (daylight) LedgerPalettes.DaylightLight else LedgerPalettes.TerminalDark,
        type = ledgerTypeTokens(treatment),
        density = LedgerDensityTokens(
            screenGutter = if (daylight) 22.dp else 20.dp,
            cardPadding = if (daylight) 17.dp else 15.dp,
            rowVerticalPadding = if (daylight) 15.dp else 12.dp,
            denseRowVerticalPadding = 11.dp,
            categoryRowVerticalPadding = 13.dp,
            sectionTopSpace = 22.dp,
            sectionLabelBottomSpace = 9.dp,
            chipGap = 6.dp,
            actionGap = 7.dp,
            minimumHitTarget = 44.dp,
            ruleStyle = if (daylight) LedgerRuleStyle.DASHED else LedgerRuleStyle.SOLID,
        ),
    )
}

val LocalLedgerTheme = staticCompositionLocalOf { themeTokens(LedgerTreatment.TERMINAL_DARK) }
val LocalLedgerEffects = staticCompositionLocalOf {
    LedgerEffectSettings().resolve(LedgerAccessibilityPreferences())
}

/** Existing routes remain on [VogelVaultTheme] until a later screen-adoption wave. */
@Composable
fun SovereignLedgerTheme(
    treatment: LedgerTreatment,
    effectSettings: LedgerEffectSettings = LedgerEffectSettings(),
    accessibility: LedgerAccessibilityPreferences = LedgerAccessibilityPreferences(),
    content: @Composable () -> Unit,
) {
    val tokens = themeTokens(treatment)
    MaterialTheme(
        colorScheme = tokens.colors.toMaterialScheme(treatment),
        typography = tokens.type.toMaterialTypography(),
    ) {
        CompositionLocalProvider(
            LocalLedgerTheme provides tokens,
            LocalLedgerEffects provides effectSettings.resolve(accessibility),
            content = content,
        )
    }
}

private fun LedgerColors.toMaterialScheme(treatment: LedgerTreatment): ColorScheme {
    val base = if (treatment == LedgerTreatment.TERMINAL_DARK) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = bitcoin,
        onPrimary = background,
        primaryContainer = bitcoinSoft,
        onPrimaryContainer = foreground,
        background = background,
        onBackground = foreground,
        surface = panel,
        onSurface = foreground,
        surfaceVariant = panelRaised,
        onSurfaceVariant = foregroundSecondary,
        outline = line,
        outlineVariant = lineSubtle,
        error = loss,
        onError = background,
        scrim = background,
    )
}

private fun LedgerTypeTokens.toMaterialTypography(): Typography = Typography(
    displayLarge = priceHero,
    displayMedium = priceHero,
    displaySmall = heroNumeral,
    headlineLarge = screenTitle,
    headlineMedium = screenTitle,
    headlineSmall = drilldownTitle,
    titleLarge = drilldownTitle,
    titleMedium = rowPrimary.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = rowPrimary.copy(fontWeight = FontWeight.Medium),
    bodyLarge = textInput,
    bodyMedium = rowPrimary,
    bodySmall = body,
    labelLarge = button,
    labelMedium = chip,
    labelSmall = kpiLabel,
)
