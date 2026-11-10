package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class ConvexDeviceCredentialTest {
    @Test
    fun `base64url issued components round trip through the single separator`() {
        val deviceId = "AbCdEf0123456789_-x"
        val deviceToken = "AbCdEf0123456789_-AbCdEf0123456789_-AbCdE"

        val parsed = ConvexDeviceCredential.parse("$deviceId.$deviceToken")

        assertEquals(deviceId, parsed.deviceId)
        assertEquals(deviceToken, parsed.deviceToken)
    }

    @Test
    fun `string form redacts the credential while equality and copy are unchanged`() {
        val credential = ConvexDeviceCredential("synthetic-device-id", "s".repeat(43), FamilyMember.MASON)

        val rendered = "$credential"
        assertFalse(rendered.contains(credential.deviceToken))
        assertFalse(rendered.contains(credential.deviceId))
        assertEquals(ConvexDeviceCredential("synthetic-device-id", "s".repeat(43), FamilyMember.MASON), credential)
        assertEquals("t".repeat(43), credential.copy(deviceToken = "t".repeat(43)).deviceToken)
        assertEquals(credential, credential.copy())
    }

    @Test
    fun `dotted components cannot shift the credential boundary`() {
        val token = "t".repeat(43)
        val malformed = listOf(
            "device.with-dot.$token",
            "device.$token.suffix",
            "device..$token",
        )

        for (credential in malformed) {
            assertFailsWith<IllegalArgumentException>(credential) {
                ConvexDeviceCredential.parse(credential)
            }
        }
        assertFailsWith<IllegalArgumentException> {
            ConvexDeviceCredential("device.with-dot", token)
        }
        assertFailsWith<IllegalArgumentException> {
            ConvexDeviceCredential("device", "${"t".repeat(32)}.suffix")
        }
    }

    @Test
    fun `malformed envelopes and component lengths fail closed`() {
        val malformed = listOf(
            "no-separator",
            ".${"t".repeat(43)}",
            "device.",
            "device.${"t".repeat(31)}",
            "device.${"t".repeat(257)}",
            "device.${"t".repeat(42)} ",
        )

        for (credential in malformed) {
            assertFailsWith<IllegalArgumentException>(credential) {
                ConvexDeviceCredential.parse(credential)
            }
        }
    }
}
