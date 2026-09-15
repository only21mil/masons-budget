package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w345dp-h870dp-mdpi")
class NarrowNavigationLabelTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `large Dashboard label stays centered within one fifth of narrow bar`() {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        try {
            controller.get().setContent {
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.5f)) {
                    LedgerTheme {
                        Row(Modifier.width(345.dp)) {
                            LedgerTabItem(Icons.Default.Home, "Home", true, {}, Modifier.weight(1f))
                            repeat(4) { LedgerTabItem(Icons.Default.Home, "Other", false, {}, Modifier.weight(1f), showLabel = false) }
                        }
                    }
                }
            }
            val results = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText("HOME", useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
            val layout = results.single()
            assertEquals(TextAlign.Center, layout.layoutInput.style.textAlign)
            assertEquals(69, layout.size.width)
            assertTrue(layout.isLineEllipsized(0))
            compose.onNodeWithText("Home").assertExists()
        } finally { controller.pause().stop().destroy() }
    }
}
