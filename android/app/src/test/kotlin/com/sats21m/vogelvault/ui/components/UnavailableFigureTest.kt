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
    fun onlyUnavailablePriceWrapsInKpiCells() {
        assertEquals(true, kpiFigureWraps(Money.PRICE_UNAVAILABLE))
        assertEquals(false, kpiFigureWraps(SUPPRESSED))
        assertEquals(false, kpiFigureWraps("\$1,250.00"))
    }
}
