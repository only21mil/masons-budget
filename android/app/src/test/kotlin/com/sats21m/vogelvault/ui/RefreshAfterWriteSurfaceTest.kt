package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.csvimport.CsvImportService
import com.sats21m.vogelvault.csvimport.CsvImportSource
import com.sats21m.vogelvault.csvimport.writeCsvImport
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexSyncTokenSource
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Regression coverage at the mutation call sites the user actually drives.
 *
 * These cases deliberately do not call result-classification helpers. Each
 * accepted and rejected response crosses the production mutation client and
 * the surface's real success branch. Removing any guarded
 * `onWriteSucceeded()` production line leaves its corresponding success
 * assertion red while the rejection assertion remains at zero.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [34],
    application = RefreshAfterWriteApplication::class,
)
class RefreshAfterWriteSurfaceTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val application: RefreshAfterWriteApplication
        get() = RuntimeEnvironment.getApplication() as RefreshAfterWriteApplication

    @Test
    fun `add transaction refreshes after success and not after rejection`() {
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.ACTIVITY,
            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            AddTransactionSheet(
                state = state,
                onDismiss = {},
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText("Merchant or destination").performTextInput("Neighborhood Market")
            compose.onNodeWithText("Amount").performTextInput("14.18")
            compose.onNode(hasText("Save") and hasClickAction()).performScrollTo()
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Transaction was not saved (http 500)",
            ),
        )
    }

    @Test
    fun `budget edit refreshes after success and not after rejection`() {
        val seed = BudgetCategoryEditorSeed(
            viewer = FamilyMember.RACHEL,
            displayedMonth = "2026-07",
            budgetDocumentMonth = "2026-07",
            category = CategorySpend("Groceries", 90_000L, 50_000L, icon = "cart"),
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            BudgetCategoryEditorSheet(
                seed = seed,
                onDismiss = {},
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNode(hasText("Save") and hasClickAction())
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Budget not saved: the write failed (http 500).",
            ),
        )
    }

    @Test
    fun `bitcoin buy refreshes after success and not after rejection`() {
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            BtcBuyEntrySheet(
                owner = FamilyMember.MASON,
                onDismiss = {},
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText("Source").performTextInput("Strike")
            compose.onNodeWithText("Sats").performTextInput("123456")
            compose.onNodeWithText("BTC price (USD)").performTextInput("117000.25")
            compose.onNodeWithText("Purchase amount (USD)").performTextInput("121.99")
            compose.onNode(hasText("Save") and hasClickAction())
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Bitcoin buy not saved: the write failed (http 500).",
            ),
        )
    }

    @Test
    fun `task add refreshes after success and not after rejection`() {
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            AddTaskSheet(
                owner = FamilyMember.MADDOX,
                onDismiss = {},
                onSaved = {},
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText("Task title").performTextInput("Finish homework")
            compose.onNode(hasText("Save task") and hasClickAction()).performScrollTo()
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Task not added: Convex rejected the write (http 500).",
            ),
        )
    }

    @Test
    fun `CSV import refreshes after success and not after rejection`() = runBlocking {
        val service = CsvImportService()
        val prepared = service.prepareTransactions(
            service.parse(
                "date,amount,memo\n2026-07-29,500,Costco".toByteArray(),
                CsvImportSource.CUSTOM,
                btcPriceCents = 10_000_000L,
            ),
            FamilyMember.VICTOR,
        )

        application.poster.response = SUCCESS
        var refreshCount = 0
        val accepted = writeCsvImport(
            prepared = prepared,
            client = application.convexMutationClient,
            onWriteSucceeded = { refreshCount++ },
        )
        assertEquals(1, accepted.savedCount)
        assertEquals(null, accepted.failure)
        assertEquals(1, refreshCount)

        application.poster.response = REJECTION
        refreshCount = 0
        val rejected = writeCsvImport(
            prepared = prepared,
            client = application.convexMutationClient,
            onWriteSucceeded = { refreshCount++ },
        )
        assertEquals(0, rejected.savedCount)
        assertEquals("http 500", assertIs<ConvexResult.Failed>(rejected.failure).reason)
        assertEquals(0, refreshCount)
    }

    @Test
    fun `screen host wires transaction success to refresh and rejects do not refresh`() {
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.ACTIVITY,
            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            ScreenHost(
                destination = Destination.ACTIVITY,
                state = state,
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText("Add").performClick()
            settle()
            compose.onNodeWithText("Merchant or destination").performTextInput("Neighborhood Market")
            compose.onNodeWithText("Amount").performTextInput("14.18")
            compose.onNode(hasText("Save") and hasClickAction()).performScrollTo()
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Transaction was not saved (http 500)",
            ),
        )
    }

    @Test
    fun `screen host wires task success to refresh and rejects do not refresh`() {
        val state = VaultUiState(
            activeProfile = FamilyMember.MADDOX,
            destination = Destination.TASKS,
            data = Fixtures.envelope(FamilyMember.MADDOX, Freshness.LIVE),
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            ScreenHost(
                destination = Destination.TASKS,
                state = state,
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText("Add task").performScrollTo().performClick()
            settle()
            compose.onNodeWithText("Task title").performTextInput("Finish homework")
            compose.onNode(hasText("Save task") and hasClickAction()).performScrollTo()
                .performSemanticsAction(SemanticsActions.OnClick)
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Task not added: Convex rejected the write (http 500).",
            ),
        )
    }

    private fun runSurface(
        response: HttpTextResponse,
        content: @Composable (() -> Unit) -> Unit,
        interact: () -> Unit,
        rejectionText: String? = null,
    ): Int {
        application.poster.response = response
        application.poster.requestCount = 0
        var refreshCount = 0
        val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        controller.get().setTheme(R.style.Theme_VogelVault)
        controller.setup()
        return try {
            compose.runOnUiThread {
                controller.get().setContent {
                    VogelVaultTheme {
                        content { refreshCount++ }
                    }
                }
            }
            settle()
            interact()
            settle()
            compose.waitUntil(timeoutMillis = 5_000L) {
                application.poster.requestCount > 0
            }
            settle()
            rejectionText?.let {
                assertEquals(
                    1,
                    compose.onAllNodesWithText(it).fetchSemanticsNodes().size,
                    "a rejected write did not name its cause",
                )
            }
            refreshCount
        } finally {
            controller.pause().stop().destroy()
        }
    }

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private companion object {
        val SUCCESS = HttpTextResponse(
            200,
            """{"status":"success","value":"accepted"}""",
        )
        val REJECTION = HttpTextResponse(500, "")
    }
}

internal class RefreshAfterWritePoster : HttpPoster {
    @Volatile
    var response: HttpTextResponse = HttpTextResponse(500, "")

    @Volatile
    var requestCount: Int = 0

    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        requestCount++
        return response
    }
}

internal class RefreshAfterWriteApplication : VaultApplication() {
    val poster = RefreshAfterWritePoster()

    override val convexMutationClient: ConvexMutationClient by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        ConvexMutationClient(
            configSource = MutableConvexConfigSource(
                ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud"),
            ),
            syncTokenSource = ConvexSyncTokenSource { "vv-test-" + UUID.randomUUID() },
            http = poster,
        )
    }
}
