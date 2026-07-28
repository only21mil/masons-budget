package com.sats21m.vogelvault

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.ScreenHost
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.components.LocalLedgerRowCompositionObserver
import com.sats21m.vogelvault.ui.components.vaultContent
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LazyLedgerCompositionTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun startComposeHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun stopComposeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `activity composes only the visible slice of a production-sized ledger`() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val transactions = List(911) { index ->
            Transaction(
                id = "transaction-$index",
                date = "2026-07-26",
                merchant = "measured-merchant-$index",
                amount = 100L + index,
                category = "Shopping",
                owner = FamilyMember.VICTOR,
            )
        }
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.ACTIVITY,
            data = base.copy(
                transactions = base.transactions.copy(
                    status = Freshness.LIVE,
                    value = transactions,
                ),
            ),
        )
        val composedRows = AtomicInteger()

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    CompositionLocalProvider(
                        LocalLedgerRowCompositionObserver provides composedRows::incrementAndGet,
                    ) {
                        Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                            ScreenHost(
                                destination = Destination.ACTIVITY,
                                state = state,
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()

        println("ACTIVITY_LEDGER_COMPOSITIONS=${composedRows.get()} TOTAL_ROWS=${transactions.size}")
        assertTrue(
            composedRows.get() in 1 until 100,
            "A 640dp viewport composed ${composedRows.get()} of 911 rows; the ledger is no longer lazy.",
        )
    }

    @Test
    fun `budget renders zero for a usable month with no transactions`() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.BUDGET,
            data = base.copy(
                transactions = base.transactions.copy(
                    status = Freshness.LIVE,
                    value = emptyList(),
                ),
            ),
        )

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 640.dp)) {
                        ScreenHost(
                            destination = Destination.BUDGET,
                            state = state,
                        )
                    }
                }
            }
        }
        compose.waitForIdle()

        assertTrue(
            compose.onAllNodesWithContentDescription("Actual, $0.00", substring = false)
                .fetchSemanticsNodes()
                .isNotEmpty(),
            "a usable empty transaction slice suppressed the true zero",
        )
    }

    @Test
    fun `keyed panel keeps remembered row state with its record after reordering`() {
        val nextToken = AtomicInteger()
        val observedTokens = mutableMapOf<String, Int>()
        lateinit var reverseRows: () -> Unit

        compose.runOnUiThread {
            activityController.get().setContent {
                var rows by remember { mutableStateOf(listOf("alpha", "bravo", "charlie")) }
                reverseRows = { rows = rows.reversed() }
                LazyColumn(Modifier.size(width = 411.dp, height = 640.dp)) {
                    vaultContent {
                        keyedPanel(
                            sectionKey = "stable-key-measurement",
                            title = "Measured rows",
                            rows = rows,
                            rowKey = { it },
                        ) { row ->
                            val token = remember { nextToken.incrementAndGet() }
                            SideEffect { observedTokens[row] = token }
                            Box(Modifier.size(width = 411.dp, height = 48.dp))
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        val before = observedTokens.toMap()

        compose.runOnUiThread { reverseRows() }
        compose.waitForIdle()

        assertTrue(before.isNotEmpty(), "The initial keyed rows did not compose.")
        assertTrue(
            observedTokens == before,
            "Remembered row state moved to a different record after reordering: " +
                "before=$before after=$observedTokens",
        )
    }
}
