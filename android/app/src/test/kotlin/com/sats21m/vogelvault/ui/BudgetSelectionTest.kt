package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1100dp-mdpi")
class BudgetSelectionTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `category selection survives refresh and missing data but clears after confirmed removal`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
            val state = mutableStateOf(VaultUiState(
                activeProfile = FamilyMember.VICTOR, destination = Destination.BUDGET, data = fixture,
            ))
            controller.get().setContent {
                LedgerTheme { Box(Modifier.size(841.dp, 945.dp)) { VaultApp(state.value, {}, {}) } }
            }
            val category = hasContentDescription("View Groceries transactions for 2026-07")
            fun row() = compose.onNode(category and hasClickAction())
            fun reveal() = compose.onNode(androidx.compose.ui.test.hasScrollToIndexAction() and
                androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag("vault-list-pane")))
                .performScrollToNode(category)
            reveal()
            row().assertIsNotSelected().performSemanticsAction(SemanticsActions.OnClick) { it() }
            row().assertIsSelected()
            val plan = fixture.budget.value!!
            compose.runOnIdle { state.value = state.value.copy(data = fixture.copy(
                budget = fixture.budget.copy(value = plan.copy(categories = plan.categories.reversed())),
            )) }
            reveal()
            row().assertIsSelected()
            compose.runOnIdle { state.value = state.value.copy(data = fixture.copy(
                budget = fixture.budget.copy(value = null, status = Freshness.LOADING),
            )) }
            compose.runOnIdle { state.value = state.value.copy(data = fixture) }
            reveal()
            row().assertIsSelected()
            compose.runOnIdle { state.value = state.value.copy(data = fixture.copy(
                budget = fixture.budget.copy(value = plan.copy(categories = plan.categories.filterNot { it.name == "Groceries" })),
            )) }
            compose.runOnIdle { state.value = state.value.copy(data = fixture) }
            reveal()
            row().assertIsNotSelected()
        } finally { controller.pause().stop().destroy() }
    }
}
