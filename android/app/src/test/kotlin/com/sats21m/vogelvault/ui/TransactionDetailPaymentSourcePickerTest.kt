package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
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
@Config(sdk = [34], application = FoldStateTestApplication::class)
class TransactionDetailPaymentSourcePickerTest {
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
    fun `card transaction displays its label and offers only card transaction sources`() {
        show(card = "coinbase_card")

        val selected = compose.onNode(hasText("Coinbase Card") and hasClickAction())
        selected.performScrollTo().assertIsDisplayed()
        check(compose.onAllNodesWithText("coinbase_card").fetchSemanticsNodes().isEmpty())

        selected.performClick()
        PaymentSource.entries.filter { it.route == PaymentSourceRoute.CARD_TRANSACTION }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isNotEmpty(),
            )
        }
        PaymentSource.entries.filter { it.route != PaymentSourceRoute.CARD_TRANSACTION }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isEmpty(),
            ) { "${source.label} cannot replace a card transaction" }
        }
    }

    @Test
    fun `non-Income refund keeps the fiat Spend source choices`() {
        show(
            card = "coinbase_card",
            amount = -1_000L,
            category = "Refund",
        )

        compose.onNode(hasText("Coinbase Card") and hasClickAction())
            .performScrollTo()
            .performClick()

        PaymentSource.entries.filter {
            it.route == PaymentSourceRoute.CARD_TRANSACTION &&
                it.supports(PaymentSourceActivity.SPEND)
        }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isNotEmpty(),
            ) { "${source.label} must remain available for a non-Income refund" }
        }
        PaymentSource.entries.filter { it.route != PaymentSourceRoute.CARD_TRANSACTION }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isEmpty(),
            ) { "${source.label} is not a transaction Spend source" }
        }
    }

    @Test
    fun `Bitcoin transaction offers only Bitcoin transaction sources`() {
        show(
            card = "zeus_on_chain",
            amountSats = 1_000L,
            bitcoinAccountKey = "zeus",
        )

        compose.onNode(hasText("Zeus On-chain") and hasClickAction())
            .performScrollTo()
            .performClick()

        PaymentSource.entries.filter { it.route == PaymentSourceRoute.BITCOIN_TRANSACTION }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isNotEmpty(),
            )
        }
        PaymentSource.entries.filter { it.route != PaymentSourceRoute.BITCOIN_TRANSACTION }.forEach { source ->
            check(
                compose.onAllNodes(hasText(source.label) and hasClickAction())
                    .fetchSemanticsNodes()
                    .isEmpty(),
            ) { "${source.label} cannot replace a Bitcoin transaction" }
        }
    }

    @Test
    fun `missing source displays as On-chain without offering a clear action`() {
        show(card = null)

        compose.onNode(hasText("On-chain") and hasClickAction())
            .performScrollTo()
            .performClick()

        check(compose.onAllNodes(hasText("No source") and hasClickAction()).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `transaction detail offers the unrecognised stored card as an explicit legacy choice`() {
        val legacyCard = "Fold card"
        show(card = legacyCard)

        compose.onNode(hasText(legacyCard) and hasClickAction())
            .performScrollTo()
            .performClick()

        val matchingChoices =
            compose.onAllNodes(hasText(legacyCard) and hasClickAction()).fetchSemanticsNodes()
        check(matchingChoices.size == 2) {
            "expected the selected legacy value and its menu choice, found ${matchingChoices.size}"
        }

        compose.onNode(hasText("Aven") and hasClickAction()).performClick()
        compose.onNode(hasText("Aven") and hasClickAction())
            .performScrollTo()
            .performClick()
        check(
            compose.onAllNodes(hasText(legacyCard) and hasClickAction())
                .fetchSemanticsNodes()
                .isNotEmpty(),
        ) { "the legacy choice disappeared after selecting a canonical source" }
    }

    @Test
    fun `transaction detail sends the selected source wire instead of its label`() {
        val actions = RecordingTransactionActions()
        show(card = "coinbase_card", actions = actions)

        compose.onNode(hasText("Coinbase Card") and hasClickAction())
            .performScrollTo()
            .performClick()
        compose.onNode(hasText("Aven") and hasClickAction()).performClick()
        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(8)
        compose.onNode(hasText("Save") and hasClickAction())
            .performClick()
        compose.waitForIdle()

        assertEquals("aven", actions.savedDraft?.method)
    }

    private fun show(
        card: String?,
        amountSats: Long? = null,
        bitcoinAccountKey: String? = null,
        amount: Long = 1_000L,
        category: String = "Other",
        actions: TransactionActions = NoOpTransactionActions,
    ) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    TransactionDetailScreen(
                        transaction = transaction(
                            card = card,
                            amountSats = amountSats,
                            bitcoinAccountKey = bitcoinAccountKey,
                            amount = amount,
                            category = category,
                        ),
                        actions = actions,
                        onClose = {},
                        onChanged = {},
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.onNode(hasText("Edit") and hasClickAction()).performClick()
        compose.waitForIdle()
    }

    private fun transaction(
        card: String?,
        amountSats: Long?,
        bitcoinAccountKey: String?,
        amount: Long,
        category: String,
    ) =
        Transaction(
            id = "source-picker-row",
            date = "2026-08-21",
            merchant = "Source Picker",
            amount = amount,
            category = category,
            card = card,
            amountSats = amountSats,
            bitcoinAccountKey = bitcoinAccountKey,
            owner = FamilyMember.VICTOR,
            updatedAtMs = 1L,
        )

    private object NoOpTransactionActions : TransactionActions {
        override suspend fun save(
            original: Transaction,
            draft: TransactionDraft,
        ): TransactionActionResult = TransactionActionResult.Success

        override suspend fun delete(transaction: Transaction): TransactionActionResult =
            TransactionActionResult.Success
    }

    private class RecordingTransactionActions : TransactionActions {
        var savedDraft: TransactionDraft? = null

        override suspend fun save(
            original: Transaction,
            draft: TransactionDraft,
        ): TransactionActionResult {
            savedDraft = draft
            return TransactionActionResult.Error("Keep the editor open for assertion.")
        }

        override suspend fun delete(transaction: Transaction): TransactionActionResult =
            TransactionActionResult.Success
    }
}
