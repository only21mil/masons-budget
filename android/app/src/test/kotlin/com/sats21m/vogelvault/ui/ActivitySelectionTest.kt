package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
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
class ActivitySelectionTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `selection follows stable transaction identity through refresh and clears on Back`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
            val first = fixture.transactions.value!!.first().copy(merchant = "Selected market")
            val second = first.copy(id = "other-record", merchant = "Other market")
            val state = mutableStateOf(VaultUiState(
                activeProfile = FamilyMember.VICTOR, destination = Destination.ACTIVITY,
                data = fixture.copy(transactions = fixture.transactions.copy(value = listOf(first, second))),
            ))
            controller.get().setContent {
                LedgerTheme { Box(Modifier.size(841.dp, 945.dp)) { VaultApp(state.value, {}, {}) } }
            }
            fun row(name: String) = compose.onNode(hasContentDescription(name, substring = true) and hasClickAction())
            row("Selected market").assertIsNotSelected()
                .performSemanticsAction(SemanticsActions.OnClick) { it() }
            row("Selected market").assertIsSelected()
            row("Other market").assertIsNotSelected()
            compose.runOnIdle {
                state.value = state.value.copy(data = state.value.data.copy(
                    transactions = state.value.data.transactions.copy(value = listOf(second, first.copy(merchant = "Renamed market"))),
                ))
            }
            row("Renamed market").assertIsSelected()
            row("Other market").assertIsNotSelected()
            compose.runOnIdle { controller.get().onBackPressedDispatcher.onBackPressed() }
            row("Renamed market").assertIsNotSelected()
        } finally { controller.pause().stop().destroy() }
    }
}
