package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProfileSwitcherTest {
    @Test
    fun `adult switch waits for authentication completion`() {
        var switchedTo: FamilyMember? = null
        val request = profileSwitchRequest(
            current = FamilyMember.VICTOR,
            target = FamilyMember.RACHEL,
            onAuthorized = { switchedTo = FamilyMember.RACHEL },
        )

        assertEquals(null, switchedTo)
        assertTrue(requireNotNull(request).requiresAuthentication)

        request.authorize()

        assertEquals(FamilyMember.RACHEL, switchedTo)
    }

    @Test
    fun `child cannot create an adult switch request`() {
        val request = profileSwitchRequest(
            current = FamilyMember.MASON,
            target = FamilyMember.VICTOR,
            onAuthorized = {},
        )

        assertNull(request)
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
