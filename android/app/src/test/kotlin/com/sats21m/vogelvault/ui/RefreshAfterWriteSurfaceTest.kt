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
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BudgetCategoryDeletionGateway
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexSyncTokenSource
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.HttpPoster
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.util.UUID
import kotlin.test.assertEquals
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
        val content: @Composable (() -> Unit) -> Unit = { _ ->
            // The transaction sheet no longer takes a composition callback: its
            // acceptance arrives via the application-level signal, counted by
            // RefreshAfterWriteApplication.acceptedWriteCount below.
            AddTransactionSheet(
                state = state,
                onDismiss = {},
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
                rejectionText = "Transaction was not saved: the write failed (http 500).",
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
            budget = Budget(month = "2026-07", categories = emptyList(), owner = FamilyMember.VICTOR, updatedAtMs = 123L),
            sourceFile = "budget",
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
    fun `budget category delete uses the paired-device gateway and refreshes only after success`() {
        val category = BudgetCategory("Groceries", 90_000L, 50_000L)
        val budget = Budget(
            month = BUDGET_DELETE_MONTH,
            categories = listOf(category),
            owner = FamilyMember.VICTOR,
            updatedAtMs = BUDGET_DELETE_REVISION,
        )
        val seed = BudgetCategoryEditorSeed(
            viewer = FamilyMember.RACHEL,
            displayedMonth = BUDGET_DELETE_MONTH,
            budgetDocumentMonth = BUDGET_DELETE_MONTH,
            category = CategorySpend("Groceries", 90_000L, 50_000L),
            budget = budget,
            sourceFile = "budget",
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            BudgetCategoryEditorSheet(
                seed = seed,
                onDismiss = {},
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNode(hasText("Delete category") and hasClickAction())
                .performSemanticsAction(SemanticsActions.OnClick)
            settle()
            compose.onNode(hasText("Confirm delete") and hasClickAction())
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
                rejectionText = "Category not deleted: http 500.",
            ),
        )
    }

    @Test
    fun `bitcoin buy refreshes after success and not after rejection`() {
        application.moneyCredentialProfile = FamilyMember.MASON
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
        application.todoCredentialProfile = FamilyMember.MADDOX
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            AddTaskSheet(
                owner = FamilyMember.MADDOX,
                onDismiss = {},
                onSaved = {},
                onWriteSucceeded = onWriteSucceeded,
                onCredentialRejected = { null },
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
                rejectionText = "Task not added (http 500)",
            ),
        )
    }

    @Test
    fun `Today add refreshes after success and not after rejection`() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state =
            VaultUiState(
                activeProfile = FamilyMember.VICTOR,
                destination = Destination.TODAY,
                data = base.copy(todos = base.todos.copy(value = emptyList())),
            )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            TodoScreen(
                state = state,
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText(application.getString(R.string.todo_new_task))
                .performTextInput("Reconcile receipts")
            compose.onNodeWithContentDescription(application.getString(R.string.todo_add))
                .performClick()
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Task not added (http 500)",
            ),
        )
    }

    @Test
    fun `Today edit refreshes after success and not after rejection`() {
        val todo =
            TodoItem(
                id = "today-refresh-edit",
                title = "Reconcile receipt",
                due = "2026-07-01",
                owner = FamilyMember.VICTOR,
            )
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state =
            VaultUiState(
                activeProfile = FamilyMember.VICTOR,
                destination = Destination.TODAY,
                data = base.copy(todos = base.todos.copy(value = listOf(todo))),
            )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            TodoScreen(
                state = state,
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithContentDescription(
                application.getString(R.string.todo_edit_named, todo.title),
            )
                .performScrollTo()
                .performClick()
            compose.onNodeWithText(application.getString(R.string.todo_title))
                .performTextReplacement("Reconcile all receipts")
            compose.onNode(hasText(application.getString(R.string.todo_save)) and hasClickAction())
                .performClick()
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Change not saved (http 500)",
            ),
        )
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
            compose.onNodeWithText("+ Add").performClick()
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
                rejectionText = "Transaction was not saved: the write failed (http 500).",
            ),
        )
    }

    @Test
    fun `screen host wires task success to refresh and rejects do not refresh`() {
        application.todoCredentialProfile = FamilyMember.MADDOX
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
                rejectionText = "Task not added (http 500)",
            ),
        )
    }

    @Test
    fun `screen host wires Today success to refresh and rejects do not refresh`() {
        val base = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.TODAY,
            data = base.copy(todos = base.todos.copy(value = emptyList())),
        )
        val content: @Composable (() -> Unit) -> Unit = { onWriteSucceeded ->
            ScreenHost(
                destination = Destination.TODAY,
                state = state,
                onWriteSucceeded = onWriteSucceeded,
            )
        }
        val interact = {
            compose.onNodeWithText(application.getString(R.string.todo_new_task))
                .performTextInput("Production shell task")
            compose.onNodeWithContentDescription(application.getString(R.string.todo_add))
                .performClick()
            Unit
        }

        assertEquals(1, runSurface(SUCCESS, content, interact))
        assertEquals(
            0,
            runSurface(
                REJECTION,
                content,
                interact,
                rejectionText = "Task not added (http 500)",
            ),
        )
    }

    /**
     * The recreation case Hermes's revision-3 verdict demanded: an Activity is
     * destroyed while its application-scoped write is in flight, the write is
     * accepted with no subscriber alive, and the REPLACEMENT activity — whose
     * collector attaches only after the acceptance — must still receive the
     * refresh signal. Real Robolectric activity lifecycles, the production
     * mutation client, and the production save function; no boolean stand-ins.
     */
    @Test
    fun `write accepted across activity recreation refreshes the replacement screen`() {
        val requestStarted = java.util.concurrent.CountDownLatch(1)
        val response = kotlinx.coroutines.CompletableDeferred<HttpTextResponse>()
        application.poster.response = HttpTextResponse(500, "")
        val gatedPoster = object : HttpPoster {
            override suspend fun postJson(url: String, body: String): HttpTextResponse {
                requestStarted.countDown()
                return response.await()
            }
        }
        val gateway = TransactionDeviceMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = gatedPoster,
            ),
        )

        var firstScreenRefreshes = 0
        val first = Robolectric.buildActivity(ComponentActivity::class.java)
        first.get().setTheme(R.style.Theme_VogelVault)
        first.setup()
        compose.runOnUiThread {
            first.get().setContent {
                VogelVaultTheme {
                    androidx.compose.runtime.LaunchedEffect(Unit) {
                        application.acceptedWrites.collect { firstScreenRefreshes++ }
                    }
                }
            }
        }
        settle()

        // The first screen starts the durable save, then dies mid-flight —
        // exactly what rotation does to a sheet with a write on the wire.
        val uiActive = java.util.concurrent.atomic.AtomicBoolean(true)
        val save = launchPreparedTransactionSave(
            scope = application.applicationScope,
            row = lifecyclePreparedRow(),
            gateway = gateway,
            transactionDraftIds = application.transactionDraftIds,
            isUiActive = uiActive::get,
            onAccepted = { application.noteAcceptedWrite() },
            onUiResult = {},
        )
        check(requestStarted.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
            "the save never reached the wire"
        }
        uiActive.set(false)
        first.pause().stop().destroy()
        settle()

        // Acceptance lands while NO activity exists.
        response.complete(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"lifecycle-row","outcome":"inserted"}}""",
            ),
        )
        runBlocking { save.join() }
        settle()
        assertEquals(
            0,
            firstScreenRefreshes,
            "the destroyed screen's collector must not have produced a refresh",
        )

        // The replacement activity subscribes AFTER the acceptance and must
        // still receive it — this is the durable-ownership guarantee.
        var replacementScreenRefreshes = 0
        val second = Robolectric.buildActivity(ComponentActivity::class.java)
        second.get().setTheme(R.style.Theme_VogelVault)
        second.setup()
        try {
            compose.runOnUiThread {
                second.get().setContent {
                    VogelVaultTheme {
                        androidx.compose.runtime.LaunchedEffect(Unit) {
                            application.acceptedWrites.collect { replacementScreenRefreshes++ }
                        }
                    }
                }
            }
            settle()
            assertEquals(
                1,
                replacementScreenRefreshes,
                "the replacement screen must receive the acceptance that landed while no activity was alive",
            )
        } finally {
            second.pause().stop().destroy()
        }
    }

    private fun lifecyclePreparedRow(): PreparedTransaction =
        prepareTransaction(
            AddTransactionDraft(
                type = AddTransactionType.SPEND,
                inputUnit = DisplayUnit.USD,
                merchant = "Lifecycle Market",
                category = "Other",
                amount = "1.00",
                card = "Fold card",
                date = java.time.LocalDate.parse("2026-07-15"),
                note = "",
                owner = FamilyMember.VICTOR,
            ),
            btcPriceCents = 0L,
            id = "lifecycle-row",
        ).getOrThrow()

    private fun runSurface(
        response: HttpTextResponse,
        content: @Composable (() -> Unit) -> Unit,
        interact: () -> Unit,
        rejectionText: String? = null,
    ): Int {
        application.poster.response = response
        application.poster.requestCount = 0
        application.acceptedWriteCount = 0
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
            refreshCount + application.acceptedWriteCount
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
        const val BUDGET_DELETE_MONTH = "2026-08"
        const val BUDGET_DELETE_REVISION = 1_787_654_321_000L
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
        if (response.code == 200 && body.contains("tables:upsertTodoFromDevice")) {
            val id = Regex("\\\"id\\\":\\\"([^\\\"]+)\\\"")
                .find(body)?.groupValues?.get(1) ?: error("todo request had no id")
            return HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"$id","outcome":"updated"}}""",
            )
        }
        if (response.code == 200 && body.contains("tables:upsertTransactionFromDevice")) {
            val id = Regex("\\\"id\\\":\\\"([^\\\"]+)\\\"")
                .find(body)?.groupValues?.get(1) ?: error("transaction request had no id")
            return HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"$id","outcome":"inserted"}}""",
            )
        }
        // The add sheet's success path now requires the server's revision-bearing
        // receipt, whose txId must match the request's generated id — echo it.
        if (response.code == 200 && body.contains("\"path\":\"tables:upsertTransaction\"")) {
            val id = Regex("\\\"id\\\":\\\"([^\\\"]+)\\\"")
                .find(body)?.groupValues?.get(1) ?: error("transaction request had no id")
            return HttpTextResponse(
                200,
                """{"status":"success","value":{"txId":"$id","owner":"victor","month":"2026-08",""" +
                    """"outcome":"inserted","updatedAtMs":1785600000000}}""",
            )
        }
        return response
    }
}

internal class RefreshAfterWriteApplication : VaultApplication() {
    val poster = RefreshAfterWritePoster()

    /**
     * Counts the process-level acceptance signal the transaction sheet now
     * uses instead of a composition callback. runSurface adds this to the
     * composition-counted refreshes so every surface keeps the same
     * one-on-success / zero-on-rejection contract.
     */
    @Volatile
    var acceptedWriteCount = 0

    override fun noteAcceptedWrite() {
        acceptedWriteCount++
        super.noteAcceptedWrite()
    }

    override fun hasConvexWriteCredential(): Boolean = true
    override fun hasTodoWriteCredential(): Boolean = true

    @Volatile
    var todoCredentialProfile: FamilyMember = FamilyMember.VICTOR

    override fun hasTodoWriteCredential(profile: FamilyMember): Boolean =
        profile == todoCredentialProfile

    override val todoMutationGateway: TodoMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential(
                        "test-device",
                        "t".repeat(43),
                        todoCredentialProfile,
                    )
                },
                http = poster,
            ),
        )
    }

    override val transactionDeviceMutationGateway: TransactionDeviceMutationGateway by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDeviceMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = poster,
            ),
        )
    }

    override val budgetCategoryDeletionGateway: BudgetCategoryDeletionGateway by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        BudgetCategoryDeletionGateway(
            client = ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(
                    ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud"),
                ),
                credentialSource = ConvexDeviceCredentialSource {
                    ConvexDeviceCredential("test-device", "t".repeat(43))
                },
                http = poster,
            ),
            trustedCurrentMonth = { "2026-08" },
        )
    }

    var moneyCredentialProfile = FamilyMember.RACHEL

    override val deviceCapabilities: com.sats21m.vogelvault.data.DeviceCapabilities
        get() = com.sats21m.vogelvault.data.DeviceCapabilities(
            moneyCredentialProfile, com.sats21m.vogelvault.data.DeviceCapabilities.supported,
        )

    override val deviceMutationClient: ConvexDeviceMutationClient by lazy {
        ConvexDeviceMutationClient(
            configSource = MutableConvexConfigSource(ConvexConfig(deploymentUrl = "https://refresh-after-write-test.convex.cloud")),
            credentialSource = ConvexDeviceCredentialSource { ConvexDeviceCredential("test-device", "t".repeat(43)) },
            http = poster,
        )
    }

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
