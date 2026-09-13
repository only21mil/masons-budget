package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.BudgetHealth
import com.sats21m.vogelvault.domain.BudgetHealthStatus
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BudgetCategoryProgressTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openActivity() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeActivity() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `green yellow and red thresholds match iOS exactly`() {
        assertEquals(
            progress(BudgetHealthStatus.ON_TRACK, "ON TRACK", 84, 8_400, 16, null, "16% left", 0.84f),
            budgetCategoryProgress(spentCents = 84L, limitCents = 100L),
        )
        assertEquals(
            progress(BudgetHealthStatus.CLOSE, "CLOSE", 85, 8_500, 15, null, "15% left", 0.85f),
            budgetCategoryProgress(spentCents = 85L, limitCents = 100L),
        )
        assertEquals(
            progress(BudgetHealthStatus.CLOSE, "CLOSE", 100, 10_000, 0, null, "0% left", 1f),
            budgetCategoryProgress(spentCents = 100L, limitCents = 100L),
        )
        assertEquals(
            progress(BudgetHealthStatus.OVER, "OVER", 100, 10_000, null, 0, "+0% over", 1f),
            budgetCategoryProgress(spentCents = 10_001L, limitCents = 10_000L),
        )
    }

    @Test
    fun `percentage truncation and two-times cap match iOS`() {
        assertEquals("66% left", budgetCategoryProgress(1L, 3L).percentageLabel)
        assertEquals("+33% over", budgetCategoryProgress(4L, 3L).percentageLabel)
        assertEquals("+100% over", budgetCategoryProgress(3L, 1L).percentageLabel)
        assertEquals(1f, budgetCategoryProgress(3L, 1L).fillFraction)
    }

    @Test
    fun `non-positive limits avoid division and use the shared safe edge states`() {
        assertEquals(
            progress(BudgetHealthStatus.ON_TRACK, "ON TRACK", 0, 0, 100, null, "100% left", 0f),
            budgetCategoryProgress(spentCents = 0L, limitCents = 0L),
        )
        assertEquals(
            progress(BudgetHealthStatus.OVER, "OVER", 200, 10_000, null, 100, "+100% over", 1f),
            budgetCategoryProgress(spentCents = 1L, limitCents = 0L),
        )
        assertEquals(
            progress(BudgetHealthStatus.ON_TRACK, "ON TRACK", 0, 0, 100, null, "100% left", 0f),
            budgetCategoryProgress(spentCents = 0L, limitCents = -1L),
        )
        assertEquals(
            progress(BudgetHealthStatus.ON_TRACK, "ON TRACK", 0, 0, 100, null, "100% left", 0f),
            budgetCategoryProgress(spentCents = -50L, limitCents = -100L),
        )
        assertEquals(
            progress(BudgetHealthStatus.OVER, "OVER", 200, 10_000, null, 100, "+100% over", 1f),
            budgetCategoryProgress(spentCents = 1L, limitCents = -100L),
        )
    }

    @Test
    fun `refund balance retains iOS percentage text but never draws negative width`() {
        assertEquals(
            progress(BudgetHealthStatus.ON_TRACK, "ON TRACK", 0, 0, 150, null, "150% left", 0f),
            budgetCategoryProgress(spentCents = -50L, limitCents = 100L),
        )
    }

    @Test
    fun `category indicator is one labelled progress node and the row opens the drilldown`() {
        val category = CategorySpend("Groceries", 10_000L, 8_500L, icon = "cart")
        val progress = budgetCategoryProgress(category.spentCents, category.budgetCents)
        val label = budgetProgressAccessibilityLabel(category, progress)

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    EditableBudgetCategoryRow(category)
                }
            }
        }
        compose.waitForIdle()

        val range =
            compose.onNodeWithContentDescription(label)
                .fetchSemanticsNode()
                .config[SemanticsProperties.ProgressBarRangeInfo]
        assertEquals(0.85f, range.current)
        assertEquals(0f..1f, range.range)
        compose.onNodeWithContentDescription("View Groceries transactions").assertHasClickAction()
        // Editing moved to the drilldown: the list row carries no edit link, badge, or percent text.
        compose.onAllNodesWithText(activityController.get().getString(R.string.budget_category_edit_action))
            .assertCountEquals(0)
        compose.onAllNodesWithText("CLOSE").assertCountEquals(0)
        compose.onAllNodesWithText("15% left").assertCountEquals(0)
        compose.onNodeWithText("OF $100.00 planned", useUnmergedTree = true).fetchSemanticsNode()
        compose.onNodeWithText("$15.00 left", useUnmergedTree = true).fetchSemanticsNode()
    }

    private fun progress(
        status: BudgetHealthStatus,
        label: String,
        usedPercent: Int,
        barBasisPoints: Int,
        remainingPercent: Int?,
        overPercent: Int?,
        percentageLabel: String,
        fillFraction: Float,
    ) = BudgetCategoryProgress(
        health = BudgetHealth(
            status = status,
            label = label,
            usedPercent = usedPercent,
            barBasisPoints = barBasisPoints,
            remainingPercent = remainingPercent,
            overPercent = overPercent,
        ),
        percentageLabel = percentageLabel,
        fillFraction = fillFraction,
    )
}
