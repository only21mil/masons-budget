package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class BtcBuyOwnerTest {
    @Test
    fun `adult household and Mason use canonical source ownership`() {
        assertNull(explicitBtcBuyOwner(FamilyMember.VICTOR))
        assertNull(explicitBtcBuyOwner(FamilyMember.RACHEL))
        assertNull(explicitBtcBuyOwner(FamilyMember.MASON))
    }

    @Test
    fun `Maddox remains explicit instead of falling into adult source ownership`() {
        assertEquals(FamilyMember.MADDOX, explicitBtcBuyOwner(FamilyMember.MADDOX))
    }
}
