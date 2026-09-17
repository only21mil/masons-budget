package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
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
    private fun render(width: Int = 320) {
        controller.get().setContent {
            LedgerTheme {
                Box(Modifier.width(width.dp)) {
                    VaultTopBar(state, {}, {}, {}, { refreshes++ })
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
