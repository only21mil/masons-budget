package com.sats21m.vogelvault.ui.components

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerStatusLineTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    @Before fun start() { controller.get().setTheme(R.style.Theme_VogelVault); controller.setup() }
    @After fun stop() { controller.pause().stop().destroy() }

    @Test fun worstConditionIsVisibleAndExpansionRevealsTheRest() {
        var retries = 0
        controller.get().setContent { VogelVaultTheme {
            LedgerStatusLine(listOf(
                LedgerCondition("read", "Read failed", "Saved figures remain visible", 10),
                LedgerCondition("write", "Bitcoin transfer not saved", "Draft retained", 100, { retries++ }),
            ))
        } }
        compose.onNodeWithText("Read failed", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retries)
        compose.onNodeWithText("Bitcoin transfer not saved", substring = true).performClick()
        compose.onNodeWithText("Read failed", substring = true).assertExists()
        compose.onNodeWithText("Draft retained").assertExists()
    }

    @Test fun acceptedWriteWarningCannotBeRetried() {
        controller.get().setContent { VogelVaultTheme {
            WriteRefusalLine("Saved, restart before another buy", {}, enabled = true, accepted = true)
        } }
        compose.onNodeWithText("Retry").assertDoesNotExist()
    }

    @Test fun largeMoneyFitsTheNarrowCellWithoutEllipsis() {
        val value = "$9,223,372,036,854.77"
        controller.get().setContent { VogelVaultTheme {
            Box(Modifier.width(100.dp)) {
                FittingFigure(value, LocalLedgerTheme.current.type.kpiValue, LocalLedgerTheme.current.colors.foreground)
            }
        } }
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(value).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(1, layouts.size)
        assertFalse(layouts.single().didOverflowWidth)
        assertFalse(layouts.single().isLineEllipsized(0))
    }

    @Test fun figureCycleAndEmptyStateRetryRetainTheirActions() {
        var cycles = 0
        var retries = 0
        controller.get().setContent { VogelVaultTheme {
            CompositionLocalProvider(LocalFigureUnitCycle provides { cycles++ }, LocalStateBlockRetry provides { retries++ }) {
                androidx.compose.foundation.layout.Column {
                    KpiStrip(listOf(Kpi("Stack", "10,000 sats")))
                    StateBlock(com.sats21m.vogelvault.domain.Freshness.ERROR, action = { StateBlockRetry() })
                }
            }
        } }
        compose.onNodeWithContentDescription("Stack, 10,000 sats").performClick()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, cycles)
        assertEquals(1, retries)
    }
}
