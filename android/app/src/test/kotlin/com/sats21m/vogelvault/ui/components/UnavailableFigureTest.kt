package com.sats21m.vogelvault.ui.components

import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import org.junit.Assert.assertEquals
import org.junit.Test

class UnavailableFigureTest {
    @Test
    fun unavailableFiguresIgnoreSemanticTone() {
        assertEquals(VaultTextDim, resolvedFigureColor(SUPPRESSED, VaultPositive))
        assertEquals(VaultTextDim, resolvedFigureColor(Money.PRICE_UNAVAILABLE, VaultNegative))
    }

    @Test
    fun availableFigureKeepsRequestedTone() {
        assertEquals(VaultPositive, resolvedFigureColor("\$1,250.00", VaultPositive))
    }

    @Test
    fun unavailablePriceIsTheSameDashAsSuppression() {
        assertEquals(SUPPRESSED, Money.PRICE_UNAVAILABLE)
        assertEquals(true, Money.PRICE_UNAVAILABLE.isUnavailableFigure())
    }

    @Test
    fun sectionSourcesDropBackendNouns() {
        assertEquals("transactions", userFacingSource("Convex rows · transactions"))
        assertEquals("budget not cached", userFacingSource("Convex rows · budget not cached"))
        assertEquals(null, userFacingSource("Convex rows"))
        assertEquals(null, userFacingSource("Convex finance document"))
        assertEquals("BTC · VOO · IBIT", userFacingSource("BTC · VOO · IBIT"))
        assertEquals(null, userFacingSource(null))
    }
}
