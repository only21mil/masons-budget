package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProfileSwitcherTest {
    @Test
    fun `adult to adult switch does not require authentication`() {
        var switchedTo: FamilyMember? = null
        val request = profileSwitchRequest(
            current = FamilyMember.VICTOR,
            target = FamilyMember.RACHEL,
            onAuthorized = { switchedTo = FamilyMember.RACHEL },
        )

        assertEquals(null, switchedTo)
        assertFalse(requireNotNull(request).requiresAuthentication)

        request.authorize()

        assertEquals(FamilyMember.RACHEL, switchedTo)
    }

    @Test
    fun `child adult entry requires device authentication`() {
        val request = profileSwitchRequest(
            current = FamilyMember.MASON,
            target = FamilyMember.VICTOR,
            onAuthorized = {},
        )

        assertTrue(requireNotNull(request).requiresAuthentication)
    }

    @Test
    fun `children cannot switch directly to a sibling`() {
        assertNull(profileSwitchRequest(FamilyMember.MASON, FamilyMember.MADDOX) {})
        assertNull(profileSwitchRequest(FamilyMember.MADDOX, FamilyMember.MASON) {})
    }

    @Test
    fun `switching to active profile creates no authentication request`() {
        assertNull(
            profileSwitchRequest(
                current = FamilyMember.RACHEL,
                target = FamilyMember.RACHEL,
                onAuthorized = {},
            ),
        )
    }
}
