package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.themeTokens
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BitcoinPriceHeroContrastTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun `rendered hero cents clear large text contrast on the panel in both treatments`() {
        val host = Robolectric.buildActivity(ComponentActivity::class.java)
        host.get().setTheme(R.style.Theme_VogelVault)
        host.setup()
        val treatment = mutableStateOf(LedgerTreatment.TERMINAL_DARK)
        try {
            compose.runOnUiThread {
                host.get().setContent {
                    LedgerTheme(treatment = treatment.value) {
                        BitcoinPriceHero(
                            MarketQuote(MarketSymbol.BTC, 10_000_123L, "test", "2026-09-07T12:00:00Z", MarketQuoteStatus.LIVE),
                        )
                    }
                }
            }
            LedgerTreatment.entries.forEach { next ->
                compose.runOnUiThread { treatment.value = next }
                compose.waitForIdle()
                val layouts = mutableListOf<TextLayoutResult>()
                val node = compose.onNodeWithText(".23", useUnmergedTree = true).fetchSemanticsNode()
                assertTrue(node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts))
                val ink = layouts.single().layoutInput.style.color
                val palette = themeTokens(next).colors
                assertEquals(palette.priceDecimals, ink)
                val rendered = ink.compositeOver(palette.panel)
                val ratio = (max(luminance(rendered), luminance(palette.panel)) + 0.05) /
                    (min(luminance(rendered), luminance(palette.panel)) + 0.05)
                assertTrue(ratio >= 3.0, "$next rendered hero cents contrast: $ratio")
            }
        } finally {
            host.pause().stop().destroy()
        }
    }
}

private fun luminance(color: Color): Double {
    fun linear(channel: Float): Double = channel.toDouble().let {
        if (it <= 0.04045) it / 12.92 else ((it + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
}
