package com.sats21m.vogelvault.ui

import android.content.Context
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.*
import com.sats21m.vogelvault.domain.*
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = BtcAccountRecoveryApplication::class)
class BtcAccountEntryRecoveryTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun `recreated oversized key request survives uncertainty then validation refusal permits corrected save`() {
        verifyRecovery("a".repeat(243), "a".repeat(243) + "-victor-abcdef")
    }

    @Test fun `recreated control character label request can be corrected after validation refusal`() {
        verifyRecovery("Cold\u0001card", "cold-card-victor-abcdef")
    }

    private fun verifyRecovery(label: String, key: String) {
        val app = ApplicationProvider.getApplicationContext<BtcAccountRecoveryApplication>()
        val preferences = app.getSharedPreferences("btc-account-drafts", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        // Represents a request persisted by a prior sheet/process before its response was known.
        val original = PendingBtcAccount(key, "victor",
            label, "exchange", "2026-08-01T12:00:00Z", 123L)
        BtcAccountDraftStore(preferences).stage(FamilyMember.RACHEL, original)
        var refreshed = 0
        val balance = Slice<BtcBalance?>(Freshness.LIVE,
            BtcBalance(FamilyMember.VICTOR, original.asOf, emptyList(), 0L, 0L, 0L, 0L, updatedAtMs = 123L),
            999L, "rows")
        fun openSheet() = Robolectric.buildActivity(ComponentActivity::class.java).also { controller ->
            controller.get().setTheme(R.style.Theme_VogelVault)
            controller.setup()
            controller.get().setContent {
                VogelVaultTheme {
                    BtcAccountEntrySheet(FamilyMember.RACHEL, balance, FamilyMember.VICTOR,
                        onDismiss = {}, onWriteSucceeded = { refreshed++ })
                }
            }
            settle()
        }
        val first = openSheet()
        try {
            compose.onNodeWithText(original.label).assertIsNotEnabled()
            compose.onNodeWithText("Save").performSemanticsAction(SemanticsActions.OnClick) { it() }
            settle()
            compose.waitUntil(5_000) { app.poster.bodies.size == 1 }
            settle()
            assertEquals(original, BtcAccountDraftStore(preferences).current(FamilyMember.VICTOR))
            compose.onNodeWithText(original.label).assertIsNotEnabled()
        } finally { first.pause().stop().destroy() }

        app.poster.response = HttpTextResponse(200,
            """{"status":"error","errorData":{"code":"VALIDATION_FAILED"}}""")
        val second = openSheet()
        try {
            compose.onNodeWithText("Save").performSemanticsAction(SemanticsActions.OnClick) { it() }
            settle()
            compose.waitUntil(5_000) { app.poster.bodies.size == 2 }
            settle()
            assertEquals(app.poster.bodies[0], app.poster.bodies[1])
            assertNull(BtcAccountDraftStore(preferences).current(FamilyMember.RACHEL))
            compose.onNodeWithText(original.label).assertIsEnabled()
            compose.onNodeWithText("✓ Exchange").assertExists()
            compose.onNodeWithText(original.label).performTextReplacement("Corrected account")
            app.poster.response = HttpTextResponse(200, """{"status":"success","value":{"ok":true}}""")
            compose.onNodeWithText("Save").performSemanticsAction(SemanticsActions.OnClick) { it() }
            settle()
            compose.waitUntil(5_000) { refreshed == 1 }
            val args = Json.parseToJsonElement(app.poster.bodies.last()).jsonObject.getValue("args").jsonObject
            val account = args.getValue("account").jsonObject
            assertEquals("Corrected account", account.getValue("label").jsonPrimitive.content)
            assertEquals("exchange", account.getValue("custody").jsonPrimitive.content)
            assertEquals(original.asOf, account.getValue("asOf").jsonPrimitive.content)
            assertEquals("123", args.getValue("baseUpdatedAtMs").jsonPrimitive.content)
            assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
            assertNotEquals(original.key, account.getValue("key").jsonPrimitive.content)
            assertNull(BtcAccountDraftStore(preferences).current(FamilyMember.VICTOR))
        } finally { second.pause().stop().destroy() }
    }

    private fun settle() {
        repeat(3) {
            compose.waitForIdle()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

internal class BtcAccountRecoveryPoster : HttpPoster {
    var response = HttpTextResponse(500, "")
    val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
    override suspend fun postJson(url: String, body: String): HttpTextResponse {
        bodies.add(body)
        return response
    }
}

internal class BtcAccountRecoveryApplication : VaultApplication() {
    val poster = BtcAccountRecoveryPoster()
    override val deviceCapabilities get() = DeviceCapabilities(FamilyMember.RACHEL, DeviceCapabilities.supported)
    override val deviceMutationClient by lazy {
        ConvexDeviceMutationClient(
            MutableConvexConfigSource(ConvexConfig(deploymentUrl = "https://account-test.convex.cloud")),
            ConvexDeviceCredentialSource { ConvexDeviceCredential("test-device", "t".repeat(43), FamilyMember.RACHEL, DeviceCapabilities.supported) },
            poster,
        )
    }
}
