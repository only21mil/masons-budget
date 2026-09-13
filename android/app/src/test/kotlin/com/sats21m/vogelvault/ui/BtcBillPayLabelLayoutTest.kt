package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner

@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w345dp-h1000dp-mdpi", application = BtcBillPayFeeApplication::class)
class BtcBillPayLabelLayoutTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>

    @After fun tearDown() { controller.pause().stop().destroy() }

    @Test fun `complete option labels fit narrow sheet at normal text`() = verifyLabels(1f)
    @Test fun `complete option labels fit narrow sheet at large text`() = verifyLabels(1.5f)
    @Test fun `complete option labels fit narrow sheet at maximum text`() = verifyLabels(2f)

    private fun verifyLabels(fontScale: Float) {
        RuntimeEnvironment.setFontScale(fontScale)
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        assertEquals(345, controller.get().resources.configuration.screenWidthDp)
        controller.get().setContent {
            VogelVaultTheme {
                BtcBillPayEntrySheet(
                    owner = FamilyMember.VICTOR,
                    budgetCategories = listOf("Housing"),
                    onDismiss = {},
                    onWriteSucceeded = {},
                )
            }
        }
        compose.waitForIdle()
        for (label in listOf("Budget category", "Credit card payment")) {
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(label, useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val layout = layouts.single()
            assertEquals(fontScale, layout.layoutInput.density.fontScale, 0.01f)
            // Compare painted line widths with the available cell. The intrinsic
            // paragraph can exceed its rounded size fractionally without clipping.
            assertFalse("$label overflows vertically at $fontScale", layout.didOverflowHeight)
            for (line in 0 until layout.lineCount) {
                assertTrue("$label exceeds available width at $fontScale",
                    layout.getLineRight(line) <= layout.layoutInput.constraints.maxWidth)
            }
            assertEquals(label.length, layout.getLineEnd(layout.lineCount - 1, visibleEnd = true))
            if (label == "Credit card payment") assertTrue("Expected narrow option to wrap", layout.lineCount > 1)
        }
        val selectedLabel = controller.get().getString(R.string.btc_bill_pay_effect_credit_card)
        compose.onNodeWithContentDescription(selectedLabel).assertIsSelected().assert(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton),
        ).assert(SemanticsMatcher("Original spoken action") {
            it.config[SemanticsActions.OnClick].label == "Select $selectedLabel"
        })
    }
}
