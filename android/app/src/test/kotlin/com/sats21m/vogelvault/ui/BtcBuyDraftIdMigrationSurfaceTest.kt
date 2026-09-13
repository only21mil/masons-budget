package com.sats21m.vogelvault.ui

import android.content.Context
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [34], application = OrdinaryTransactionLegacyLeaseApplication::class)
class OrdinaryTransactionLegacyLeaseTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun `opening an ordinary transaction leaves the legacy bitcoin buy lease untouched`() {
        val application = RuntimeEnvironment.getApplication() as OrdinaryTransactionLegacyLeaseApplication
        val preferences = application.getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
        val incomeScope = btcBuyDraftIdScope(BtcBuyWriteSurface.INCOME_LINKED, FamilyMember.VICTOR)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        controller.get().setTheme(R.style.Theme_VogelVault)

        try {
            compose.runOnUiThread {
                controller.get().setContent {
                    VogelVaultTheme {
                        AddTransactionSheet(
                            state = VaultUiState(
                                activeProfile = FamilyMember.VICTOR,
                                destination = Destination.ACTIVITY,
                                data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
                            ),
                            onDismiss = {},
                        )
                    }
                }
            }
            compose.waitForIdle()

            assertEquals(LEGACY_ID, preferences.getString(LEGACY_KEY, null))
            assertNull(preferences.getString(incomeScope, null))
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test
    fun `invalid income bitcoin buy tap consumes no legacy lease`() {
        val application = RuntimeEnvironment.getApplication() as OrdinaryTransactionLegacyLeaseApplication
        val preferences = application.getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
        val incomeScope = btcBuyDraftIdScope(BtcBuyWriteSurface.INCOME_LINKED, FamilyMember.VICTOR)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        controller.get().setTheme(R.style.Theme_VogelVault)

        try {
            compose.runOnUiThread {
                controller.get().setContent {
                    VogelVaultTheme {
                        AddTransactionSheet(
                            state = VaultUiState(
                                activeProfile = FamilyMember.VICTOR,
                                destination = Destination.BUDGET,
                                data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
                            ),
                            onDismiss = {},
                            allowIncomeBitcoinBuy = true,
                        )
                    }
                }
            }
            compose.waitForIdle()
            compose.onNode(hasText("Income") and hasClickAction())
                .performScrollTo()
                .performSemanticsAction(SemanticsActions.OnClick)
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
            compose.onNodeWithText("Amount").performTextInput("100.00")
            compose.onNodeWithText("Next").performSemanticsAction(SemanticsActions.OnClick)
            compose.onNodeWithText("Payment, date, note and Bitcoin")
                .performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
            compose
                .onNodeWithText(application.getString(R.string.budget_income_add_as_bitcoin_buy))
                .performScrollTo()
                .assertIsEnabled()
                .performSemanticsAction(SemanticsActions.OnClick)
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
            compose
                .onNodeWithText("Enter an income source")
                .fetchSemanticsNode()

            assertEquals(LEGACY_ID, preferences.getString(LEGACY_KEY, null))
            assertNull(preferences.getString(incomeScope, null))
        } finally {
            controller.pause().stop().destroy()
        }
    }
}

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [34], application = MaddoxLegacyLeaseApplication::class)
class MaddoxLegacyLeaseTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun `opening Maddox bitcoin buy cannot claim the adult legacy lease`() {
        val application = RuntimeEnvironment.getApplication() as MaddoxLegacyLeaseApplication
        val preferences = application.getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
        val maddoxScope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, FamilyMember.MADDOX)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        controller.get().setTheme(R.style.Theme_VogelVault)

        try {
            compose.runOnUiThread {
                controller.get().setContent {
                    VogelVaultTheme {
                        BtcBuyEntrySheet(
                            owner = FamilyMember.MADDOX,
                            onDismiss = {},
                            onWriteSucceeded = {},
                        )
                    }
                }
            }
            compose.waitForIdle()

            compose.onNodeWithText("Save").fetchSemanticsNode()
            val maddoxId = assertNotNull(preferences.getString(maddoxScope, null))
            assertNotEquals(LEGACY_ID, maddoxId)
            assertEquals(LEGACY_ID, preferences.getString(LEGACY_KEY, null))
        } finally {
            controller.pause().stop().destroy()
        }
    }
}

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [34], application = PartiallyMigratedLeaseApplication::class)
class PartiallyMigratedLeaseTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun `opening a scoped bitcoin buy does not clear the adult legacy lease`() {
        val application = RuntimeEnvironment.getApplication() as PartiallyMigratedLeaseApplication
        val preferences = application.getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
        val victorScope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, FamilyMember.VICTOR)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        controller.get().setTheme(R.style.Theme_VogelVault)

        try {
            compose.runOnUiThread {
                controller.get().setContent {
                    VogelVaultTheme {
                        BtcBuyEntrySheet(
                            owner = FamilyMember.VICTOR,
                            onDismiss = {},
                            onWriteSucceeded = {},
                        )
                    }
                }
            }
            compose.waitForIdle()

            compose.onNodeWithText("Save").fetchSemanticsNode()
            assertEquals(SCOPED_ID, preferences.getString(victorScope, null))
            assertEquals(LEGACY_ID, preferences.getString(LEGACY_KEY, null))
        } finally {
            controller.pause().stop().destroy()
        }
    }
}

internal class OrdinaryTransactionLegacyLeaseApplication : VaultApplication() {
    override val deviceCapabilities = DeviceCapabilities(
        FamilyMember.VICTOR,
        setOf(DeviceCapability.TRANSACTIONS.wire, DeviceCapability.BITCOIN.wire),
    )
    override fun onCreate() {
        getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .putString(LEGACY_KEY, LEGACY_ID)
            .commit()
        super.onCreate()
    }
}

internal class MaddoxLegacyLeaseApplication : VaultApplication() {
    override val deviceCapabilities = DeviceCapabilities(
        FamilyMember.MADDOX, setOf(DeviceCapability.BITCOIN.wire),
    )
    override fun onCreate() {
        getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .putString(LEGACY_KEY, LEGACY_ID)
            .commit()
        super.onCreate()
    }
}

internal class PartiallyMigratedLeaseApplication : VaultApplication() {
    override val deviceCapabilities = DeviceCapabilities(
        FamilyMember.VICTOR, setOf(DeviceCapability.BITCOIN.wire),
    )
    override fun onCreate() {
        val victorScope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, FamilyMember.VICTOR)
        getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .putString(LEGACY_KEY, LEGACY_ID)
            .putString(victorScope, SCOPED_ID)
            .commit()
        super.onCreate()
    }
}

private const val BTC_BUY_DRAFT_ID_PREFERENCES = "btc_buy_draft_ids"
private const val LEGACY_KEY = "bitcoin-buys"
private const val LEGACY_ID = "android-legacy-adult"
private const val SCOPED_ID = "android-scoped-adult"
