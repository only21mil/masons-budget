package com.sats21m.vogelvault.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.sats21m.vogelvault.domain.FamilyMember
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BtcAccountDraftStoreTest {
    @Test fun `recreated store sends original revision and as of in the actual device request`() = runBlocking {
        val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("account-test", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        val original = PendingBtcAccount("coldcard-victor-new", "victor", "Coldcard", "self_custody", "2026-08-01T12:00:00Z", 123L)
        BtcAccountDraftStore(preferences).stage(FamilyMember.RACHEL, original)
        val restored = BtcAccountDraftStore(preferences).stage(FamilyMember.VICTOR,
            original.copy(asOf = "2026-09-13T12:00:00Z", baseUpdatedAtMs = 456L, label = "Changed"))
        val poster = RecordingPoster(HttpTextResponse(200, """{"status":"success","value":{"ok":true}}"""))
        val client = ConvexDeviceMutationClient(
            MutableConvexConfigSource(ConvexConfig(deploymentUrl = "https://test.convex.cloud", remoteReadEnabled = true)),
            ConvexDeviceCredentialSource { ConvexDeviceCredential("test-device", "a".repeat(32), FamilyMember.RACHEL, DeviceCapabilities.supported) },
            poster,
        )
        client.mutate(restored.mutation())
        val request = Json.parseToJsonElement(poster.bodies.single()).jsonObject
        val args = request.getValue("args").jsonObject
        assertEquals("tables:upsertBtcAccountFromDevice", request.getValue("path").jsonPrimitive.content)
        assertEquals("123", args.getValue("baseUpdatedAtMs").jsonPrimitive.content)
        assertEquals("victor", args.getValue("owner").jsonPrimitive.content)
        assertEquals("btc-balance-snapshot", args.getValue("sourceFile").jsonPrimitive.content)
        val account = args.getValue("account").jsonObject
        assertEquals(original.asOf, account.getValue("asOf").jsonPrimitive.content)
        assertEquals(original.label, account.getValue("label").jsonPrimitive.content)
        assertFalse("fiatCents" in account)
        assertFalse("fiatValuation" in account)
        assertEquals("AAAAAAAAAAA=", account.getValue("sats").jsonObject.getValue("\$integer").jsonPrimitive.content)
        assertFalse("baseUpdatedAtMs" in original.copy(baseUpdatedAtMs = null).mutation().arguments())
    }
}
