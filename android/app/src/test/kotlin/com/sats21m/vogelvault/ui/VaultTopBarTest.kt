package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.components.VAULT_SYNC_CONTROL_TEST_TAG
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w400dp-h800dp-mdpi")
class VaultTopBarTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var controller: ActivityController<ComponentActivity>
    private var state by mutableStateOf(VaultUiState.of(FamilyMember.VICTOR, status = Freshness.STALE))
    private var refreshes = 0

    @Before fun start() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
    }
    @After fun stop() { controller.pause().stop().destroy() }
    private fun render(width: Int = 320, fontScale: Float = 1f) {
        controller.get().setContent {
            LedgerTheme {
                CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
                    Box(Modifier.width(width.dp)) {
                        VaultTopBar(state, {}, {}, {}, { refreshes++ })
                    }
                }
            }
        }
        compose.waitForIdle()
    }
    @Test fun `320dp adult bar keeps sync and trailing gear displayed on one line`() {
        render()
        for (status in Freshness.entries) {
            compose.runOnIdle { state = VaultUiState.of(FamilyMember.VICTOR, status = status) }
            val gear = compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).assertIsDisplayed().assertWidthIsEqualTo(48.dp)
            val sync = compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).assertIsDisplayed().assertWidthIsEqualTo(48.dp)
            compose.onNodeWithTag(VAULT_TOP_BAR_TEST_TAG).assertHeightIsEqualTo(64.dp)
            val gearBounds = gear.fetchSemanticsNode().boundsInRoot
            val syncBounds = sync.fetchSemanticsNode().boundsInRoot
            assertEquals(308f, gearBounds.right)
            assertEquals(gearBounds.center.y, syncBounds.center.y)
            assertTrue(syncBounds.right <= gearBounds.left)
        }
        compose.onNodeWithContentDescription("Settings").assertIsDisplayed()
    }
    @Test fun `320dp child bar keeps the short badge and sync with no gear`() {
        state = VaultUiState.of(FamilyMember.MADDOX, status = Freshness.STALE)
        render()
        compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).assertDoesNotExist()
        compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).assertIsDisplayed()
        compose.onNodeWithContentDescription("Child profile").assertIsDisplayed()
        compose.onNodeWithText("Child", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag(VAULT_TOP_BAR_TEST_TAG).assertHeightIsEqualTo(64.dp)
    }
    @Test fun `loading with no prior age shows no age text`() {
        state = VaultUiState.of(FamilyMember.VICTOR, status = Freshness.LOADING).let { loading ->
            loading.copy(data = loading.data.copy(transactions = loading.data.transactions.copy(updatedAt = null)))
        }
        assertEquals(null, state.worstUpdatedAt)
        render(400)
        compose.onNodeWithContentDescription("Syncing").assertIsDisplayed().assertIsNotEnabled()
        val sync = compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).fetchSemanticsNode()
        assertTrue(sync.config.getOrElse(SemanticsProperties.Text) { emptyList() }.isEmpty())
        compose.onNodeWithText("never").assertDoesNotExist()
    }
    @Test fun `long display name ellipsizes and gear stays flush`() {
        state = VaultUiState.of(FamilyMember.RACHEL)
        // Names come from a fixed enum; enlarged text exercises a name wider than its slot.
        render(fontScale = 5f)
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Rachel", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertTrue(layouts.single().isLineEllipsized(0))
        assertEquals(1, layouts.single().lineCount)
        val gear = compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).assertIsDisplayed().assertWidthIsEqualTo(48.dp)
        assertEquals(308f, gear.fetchSemanticsNode().boundsInRoot.right)
        compose.onNodeWithTag(VAULT_TOP_BAR_TEST_TAG).assertHeightIsEqualTo(64.dp)
    }
    @Test fun `360dp child bar keeps full Child profile badge on one line`() {
        state = VaultUiState.of(FamilyMember.MADDOX, status = Freshness.STALE)
        render(360)
        compose.onNodeWithTag(VAULT_GEAR_MENU_TEST_TAG).assertDoesNotExist()
        val layouts = mutableListOf<TextLayoutResult>()
        val badge = compose.onNodeWithText("Child profile", useUnmergedTree = true).assertIsDisplayed()
        badge.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(1, layouts.single().lineCount)
        assertTrue(!layouts.single().isLineEllipsized(0))
        assertTrue(layouts.single().getLineRight(0) <= layouts.single().size.width + 1f)
        assertTrue(!layouts.single().didOverflowHeight)
        val sync = compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val badgeBounds = badge.fetchSemanticsNode().boundsInRoot
        assertEquals(sync.center.y, badgeBounds.center.y)
        assertTrue(badgeBounds.right <= sync.left)
        compose.onNodeWithTag(VAULT_TOP_BAR_TEST_TAG).assertHeightIsEqualTo(64.dp)
    }
    @Test fun `compact age remains available through semantics and long press`() {
        state = state.copy(now = requireNotNull(state.worstUpdatedAt) + 180_000)
        render()
        val description = "Stale. Synced 3 minutes ago. Refresh"
        compose.onNodeWithContentDescription(description).assertIsDisplayed()
        compose.onNodeWithText("3m").assertDoesNotExist()
        compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).performTouchInput { longClick() }
        compose.onNodeWithText(description).assertIsDisplayed()
        assertEquals(0, refreshes)
    }
    @Test fun `wide bar retains last sync age while loading`() {
        val timestamp = requireNotNull(state.worstUpdatedAt)
        state = state.copy(now = timestamp + 180_000)
        render(400)
        compose.onNodeWithText("3m").assertIsDisplayed()
        compose.onNodeWithContentDescription("Stale. Synced 3 minutes ago. Refresh").assertExists()
        compose.runOnIdle {
            state = VaultUiState.of(FamilyMember.VICTOR, status = Freshness.LOADING).let { loading ->
                loading.copy(now = timestamp + 180_000, data = loading.data.copy(
                    transactions = loading.data.transactions.copy(updatedAt = null),
                    btcAccounts = loading.data.btcAccounts.copy(updatedAt = null),
                    btcBuys = loading.data.btcBuys.copy(updatedAt = null),
                    todos = loading.data.todos.copy(updatedAt = null),
                    budget = loading.data.budget.copy(updatedAt = null),
                ))
            }
        }
        compose.onNodeWithContentDescription("Syncing").assertIsNotEnabled()
        compose.onNodeWithText("3m").assertIsDisplayed()
    }
    @Test fun `sync refresh retries but loading and demo ignore taps`() {
        render(400)
        compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).performClick()
        assertEquals(1, refreshes)
        compose.runOnIdle { state = VaultUiState.of(FamilyMember.VICTOR, status = Freshness.ERROR) }
        compose.onNodeWithContentDescription("Sync failed. Retry").performClick()
        compose.onNodeWithText("ERR").assertIsDisplayed()
        assertEquals(2, refreshes)
        for (status in listOf(Freshness.LOADING, Freshness.DEMO)) {
            compose.runOnIdle { state = VaultUiState.of(FamilyMember.VICTOR, status = status) }
            compose.onNodeWithTag(VAULT_SYNC_CONTROL_TEST_TAG).assertIsNotEnabled().performClick()
        }
        compose.onNodeWithContentDescription("Sync unavailable in demo").assertExists()
        assertEquals(2, refreshes)
    }
}
