package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertTrue
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
@Config(sdk = [34], qualifiers = "w701dp-h841dp-420dpi")
class LedgerSheetHingeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }

    @Test fun `tabletop task fields and actions fit inside the selected hinge region`() {
        // Native Pixel Fold acceptance: 1840 x 2208px, 420dpi, horizontal hinge at y=1104px.
        val region = LedgerSheetRegion(0.dp, 0.dp, (1840f / 2.625f).dp, (1104f / 2.625f).dp)
        controller.get().setContent {
            VogelVaultTheme {
                CompositionLocalProvider(LocalLedgerSheetRegion provides region) {
                    AddTaskSheet(FamilyMember.VICTOR, {}, {}, {}, { null })
                }
            }
        }
        compose.waitForIdle()
        val actions = compose.onNodeWithTag("ledger-sheet-actions").fetchSemanticsNode().boundsInRoot
        assertTrue(actions.height > 0 && actions.top >= 0 && actions.bottom <= 1104f,
            "Actions must fit above the hinge; actual bounds: $actions")
        compose.onNodeWithText("Cancel").assertIsDisplayed()
        compose.onNodeWithText("Save task").assertIsDisplayed()
        compose.onAllNodes(hasSetTextAction())[0].assertIsDisplayed().performTextInput("Tabletop task")
        compose.onNodeWithText("Tabletop task").assertIsDisplayed()
        compose.onNodeWithText("Flag this task").performScrollTo().assertIsDisplayed()
        val after = compose.onNodeWithTag("ledger-sheet-actions").fetchSemanticsNode().boundsInRoot
        assertTrue(after == actions, "Actions must stay pinned while the form scrolls")
    }
}
