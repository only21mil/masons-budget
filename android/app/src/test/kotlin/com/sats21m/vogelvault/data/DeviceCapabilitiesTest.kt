package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class DeviceCapabilitiesTest {
    @Test
    fun `unpaired other profile and unsupported writes are refused before typing`() {
        val legacy = DeviceCapabilities(FamilyMember.RACHEL, DeviceCapabilities.legacy)
        for (capability in DeviceCapability.entries) {
            assertFalse(DeviceCapabilities().allows(FamilyMember.RACHEL, capability))
            assertNotNull(DeviceCapabilities().unavailableReason(FamilyMember.RACHEL, capability))
            assertFalse(legacy.allows(FamilyMember.VICTOR, capability))
        }
        assertTrue(legacy.allows(FamilyMember.RACHEL, DeviceCapability.TODOS))
        assertNull(legacy.unavailableReason(FamilyMember.RACHEL, DeviceCapability.TODOS))
        assertFalse(legacy.allows(FamilyMember.RACHEL, DeviceCapability.BITCOIN))
    }

    @Test
    fun `adult money grants cover the household while tasks and children stay profile bound`() {
        val granted = DeviceCapabilities(FamilyMember.RACHEL, DeviceCapabilities.supported)
        for (capability in listOf(DeviceCapability.TRANSACTIONS, DeviceCapability.BUDGET, DeviceCapability.BITCOIN)) {
            assertTrue(granted.allows(FamilyMember.VICTOR, capability))
            assertNull(granted.unavailableReason(FamilyMember.VICTOR, capability))
            assertFalse(granted.allows(FamilyMember.MASON, capability))
            assertFalse(DeviceCapabilities(FamilyMember.MASON, DeviceCapabilities.supported).allows(FamilyMember.VICTOR, capability))
        }
        assertFalse(granted.allows(FamilyMember.VICTOR, DeviceCapability.TODOS))
    }

    @Test
    fun `device Bitcoin deletes retain server revision and correct source`() {
        for (kind in BitcoinDeleteKind.entries) {
            val mutation = ConvexMutation.DeleteBitcoinFromDevice(kind, "record", FamilyMember.RACHEL, 123L)
            assertEquals(kind.path, mutation.path)
            assertEquals(kind.sourceFile, mutation.arguments()["sourceFile"]?.jsonPrimitive?.content)
            assertEquals("victor", mutation.arguments()["owner"]?.jsonPrimitive?.content)
            assertEquals("123", mutation.arguments()["baseUpdatedAtMs"]?.jsonPrimitive?.content)
            assertEquals("record", mutation.arguments()["entityId"]?.jsonPrimitive?.content)
            assertFalse("token" in mutation.arguments())
        }
    }

    @Test
    fun `account creation uses device schema without untrusted fiat valuation`() {
        val mutation = ConvexMutation.UpsertBtcAccountFromDevice(
            BtcAccountInput("account", FamilyMember.VICTOR, "Wallet", Custody.SELF_CUSTODY, 0L, 0L, "2026-09-13T12:00:00Z"),
        )
        assertEquals("tables:upsertBtcAccountFromDevice", mutation.path)
        assertEquals("btc-balance-snapshot", mutation.arguments()["sourceFile"]?.jsonPrimitive?.content)
        val account = mutation.arguments()["account"]!!.jsonObject
        assertFalse("fiatCents" in account)
        assertFalse("fiatValuation" in account)
        assertEquals("AAAAAAAAAAA=", account["sats"]!!.jsonObject["\$integer"]?.jsonPrimitive?.content)
    }
}
