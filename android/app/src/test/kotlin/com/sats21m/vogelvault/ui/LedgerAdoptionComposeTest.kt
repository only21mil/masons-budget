package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import java.time.YearMonth
import java.time.ZoneOffset
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerAdoptionComposeTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `onboarding exposes all three steps before connection controls`() {
        render {
            OnboardingView(
                configurationError = null,
                remoteReadReady = false,
                onConnected = {},
            )
        }

        compose.onNodeWithText("Connect Vogel Vault").fetchSemanticsNode()
        compose.onNodeWithText("Step 1 of 3", ignoreCase = true).fetchSemanticsNode()
        compose.onNodeWithText("Next").performClick()
        settle()
        compose.onNodeWithText("Profiles stay scoped").fetchSemanticsNode()
        compose.onNodeWithText("Next").performClick()
        settle()
        compose.onNodeWithText("Pair this device").fetchSemanticsNode()
        compose.onNodeWithText("Step 3 of 3", ignoreCase = true).fetchSemanticsNode()
    }

    @Test
    fun `current category editor exposes a two-tap delete boundary`() {
        val month = YearMonth.now(ZoneOffset.UTC).toString()
        val category = CategorySpend("Groceries", 50_000L, 12_000L)
        val budget = Budget(
            month = month,
            categories = emptyList(),
            owner = FamilyMember.VICTOR,
            updatedAtMs = 123L,
        )
        render {
            BudgetCategoryEditorSheet(
                seed = BudgetCategoryEditorSeed(
                    viewer = FamilyMember.VICTOR,
                    displayedMonth = month,
                    budgetDocumentMonth = month,
                    category = category,
                    budget = budget,
                    sourceFile = "budget",
                ),
                onDismiss = {},
                onWriteSucceeded = {},
            )
        }

        compose.onNodeWithText("Delete category").fetchSemanticsNode()
        compose.onNode(hasText("Delete category") and hasClickAction())
            .performSemanticsAction(SemanticsActions.OnClick)
        settle()
        compose.onNodeWithText(
            "Tap delete again to remove Groceries from the current budget.",
        ).fetchSemanticsNode()
        compose.onNode(hasText("Confirm delete") and hasClickAction()).fetchSemanticsNode()
    }

    @Test
    fun `price family payment rails and five folded tabs render from adopted UI`() {
        val quote = MarketQuote(
            symbol = MarketSymbol.BTC,
            priceCents = 9_425_012L,
            source = "Vogel price service",
            fetchedAt = "2026-08-26T12:00:00Z",
            status = MarketQuoteStatus.LIVE,
        )
        render {
            BitcoinPriceHero(quote)
        }
        compose.onNodeWithText("$94,250").fetchSemanticsNode()
        compose.onNodeWithText(".12").fetchSemanticsNode()
        compose.onNodeWithText(
            "VOGEL PRICE SERVICE · 2026-08-26T12:00:00Z",
        ).fetchSemanticsNode()

        render {
            Column {
                PaymentRail(PaymentSource.ZEUS_LIGHTNING)
                PaymentRail(PaymentSource.ZEUS_ON_CHAIN)
            }
        }
        compose.onNodeWithText("BOLT · ZEUS LIGHTNING").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Bolt payment rail").fetchSemanticsNode()
        compose.onNodeWithText("CHAIN · ZEUS ON-CHAIN").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Chain payment rail").fetchSemanticsNode()

        render {
            ScreenHost(
                destination = Destination.FAMILY,
                state = VaultUiState.of(FamilyMember.RACHEL, Destination.FAMILY),
            )
        }
        // Section labels draw uppercase and speak their original casing.
        compose.onNodeWithContentDescription("Active profile scope").fetchSemanticsNode()
        compose.onNodeWithText(
            "Adult household + child oversight",
            useUnmergedTree = true,
        ).fetchSemanticsNode()

        render {
            VaultApp(
                state = VaultUiState(
                    activeProfile = FamilyMember.VICTOR,
                    destination = Destination.DASHBOARD,
                    data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
                ),
                onNavigate = {},
                onSwitchProfile = {},
            )
        }
        RAIL_PRIMARY_ORDER.forEach { destination ->
            compose.onNodeWithContentDescription(destination.label).fetchSemanticsNode()
        }
        compose.onNodeWithText("More (9)").assertDoesNotExist()
    }

    @Test
    fun `appearance and behavior controls emit changed settings`() {
        render {
            LedgerAppearanceSettings(
                settings = LedgerUiSettings(),
                onSettingsChange = {},
            )
        }

        compose.onNodeWithContentDescription("Daylight appearance").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Scanlines, off").fetchSemanticsNode()
        compose.onNodeWithContentDescription("Reduce motion, off").fetchSemanticsNode()
    }

    private fun render(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread {
            activityController.get().setContent {
                LedgerTheme {
                    Box(Modifier.size(width = 411.dp, height = 891.dp)) {
                        content()
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }
}
