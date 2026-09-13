package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.time.LocalDate
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
@Config(sdk = [34], qualifiers = "w345dp-h500dp")
class LedgerSheetTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }

    @Test fun `long form scrolls while save and cancel stay pinned`() {
        var saved = false
        controller.get().setContent {
            VogelVaultTheme {
                LedgerSheet("Edit", {}, actions = {
                    Row {
                        TextButton({}) { Text("Cancel") }
                        TextButton({ saved = true }) { Text("Save") }
                    }
                }) { repeat(30) { Text("Field $it") } }
            }
        }
        compose.onNodeWithText("Save").assertIsDisplayed()
        compose.onNodeWithText("Cancel").assertIsDisplayed()
        val before = compose.onNodeWithTag("ledger-sheet-actions").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithText("Field 29").performScrollTo().assertIsDisplayed()
        val after = compose.onNodeWithTag("ledger-sheet-actions").fetchSemanticsNode().boundsInRoot
        assertEquals(before, after)
        compose.onNodeWithText("Save").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.runOnIdle { assertEquals(true, saved) }
    }

    @Test fun `disabled selection cannot change through its semantic action`() {
        var selected = false
        controller.get().setContent {
            VogelVaultTheme {
                SelectionChip("Exchange", "Exchange", "Select Exchange", selected = false,
                    enabled = false, onSelect = { selected = true })
            }
        }
        compose.onNodeWithText("Exchange").assertIsNotEnabled()
            .performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.runOnIdle { assertEquals(false, selected) }
    }

    @Test fun `optional date opens picker and can be cleared`() {
        val value = mutableStateOf("2026-09-13")
        controller.get().setContent {
            VogelVaultTheme {
                LedgerDateField(value.value, { value.value = it }, "Due date", optional = true)
            }
        }
        compose.onNode(hasText("2026-09-13") and hasClickAction()).performClick()
        compose.onNodeWithText(controller.get().getString(R.string.add_transaction_date_confirm)).performClick()
        assertEquals("2026-09-13", value.value)
        compose.onNodeWithText("Clear date").performClick()
        assertEquals("", value.value)
        compose.onNodeWithText("Choose date").assertIsDisplayed()
    }
}
