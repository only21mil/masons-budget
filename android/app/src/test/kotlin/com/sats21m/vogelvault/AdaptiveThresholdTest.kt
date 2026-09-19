package com.sats21m.vogelvault

import androidx.compose.ui.graphics.Color
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.BitcoinSegment
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.UNFOLDED_MIN_WIDTH_DP
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.foldedPrimaryDestinations
import com.sats21m.vogelvault.ui.RAIL_PRIMARY_ORDER
import com.sats21m.vogelvault.ui.railPrimaryDestinations
import com.sats21m.vogelvault.ui.theme.VaultBitcoin
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultNavSlate
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultWarning
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Plain JVM tests — no Robolectric, so they are fast and always run.
 *
 * These guard the contract between the adaptive threshold and the device
 * qualifiers the design packet renders at. If someone moves the threshold without
 * moving the qualifiers, the packet would silently stop demonstrating the switch.
 */
class AdaptiveThresholdTest {

    private fun widthOf(qualifier: String): Int =
        Regex("""w(\d+)dp""").find(qualifier)!!.groupValues[1].toInt()

    @Test
    fun `folded is below the threshold and unfolded is above it`() {
        val folded = widthOf(RobolectricDeviceQualifiers.FOLDED)
        val unfolded = widthOf(RobolectricDeviceQualifiers.UNFOLDED)

        assertTrue(folded < UNFOLDED_MIN_WIDTH_DP, "folded ${folded}dp must select the bottom bar")
        assertTrue(unfolded >= UNFOLDED_MIN_WIDTH_DP, "unfolded ${unfolded}dp must select the rail")
    }

    @Test
    fun `the two postures are meaningfully different widths`() {
        val folded = widthOf(RobolectricDeviceQualifiers.FOLDED)
        val unfolded = widthOf(RobolectricDeviceQualifiers.UNFOLDED)
        assertTrue(unfolded - folded > 300, "a Fold roughly doubles in width when opened")
    }
}

/** Destination catalog and folded-navigation partitioning. */
class DestinationVisibilityTest {

    @Test
    fun `bitcoin segments cover net worth and retirement without top-level destinations`() {
        assertEquals(
            listOf("Overview", "Net Worth", "Retirement"),
            BitcoinSegment.entries.map { it.label },
        )
    }

    @Test
    fun `both postures use the same five primary destinations without More`() {
        val destinations = Destination.entries.toList()
        val expected = listOf(Destination.HOME, Destination.BUDGET, Destination.ACTIVITY, Destination.BITCOIN, Destination.TASKS)
        assertEquals(expected, foldedPrimaryDestinations(destinations))
        assertEquals(expected, railPrimaryDestinations(destinations))
    }

    @Test
    fun `folded navigation does not add More when all destinations fit`() {
        val destinations = Destination.entries.take(5)

        assertEquals(destinations.filter { it in RAIL_PRIMARY_ORDER }, foldedPrimaryDestinations(destinations))
    }

    @Test
    fun `remote-disabled fixtures never claim to be live or synced`() {
        val state = VaultViewModel(remoteInitiallyEnabled = false).state.value

        assertEquals(Freshness.DEMO, state.worstStatus)
        assertFalse(state.worstStatus == Freshness.LIVE)
        assertNull(state.worstUpdatedAt)
        assertTrue(
            listOf(
                state.data.transactions,
                state.data.btcAccounts,
                state.data.btcBuys,
                state.data.todos,
            ).all {
                it.status == Freshness.DEMO &&
                    it.status != Freshness.LIVE &&
                    it.updatedAt == null
            },
        )
        assertEquals(Freshness.DEMO, state.data.budget.status)
        assertFalse(state.data.budget.status == Freshness.LIVE)
        assertNull(state.data.budget.updatedAt)
    }

    @Test
    fun `children cannot navigate household settings export or family`() {
        for (child in listOf(FamilyMember.MASON, FamilyMember.MADDOX)) {
            val viewModel = VaultViewModel(remoteInitiallyEnabled = false)
            viewModel.switchProfile(child)

            for (destination in Destination.entries) {
                val previous = viewModel.state.value.destination
                viewModel.navigate(destination)
                val expected = if (destination in setOf(Destination.SETTINGS, Destination.EXPORT, Destination.FAMILY)) previous else destination
                assertEquals(expected, viewModel.state.value.destination)
            }
        }
    }

    @Test
    fun `profile switching leaves adult settings`() {
        val viewModel = VaultViewModel(remoteInitiallyEnabled = false)
        viewModel.navigate(Destination.SETTINGS)

        viewModel.switchProfile(FamilyMember.MASON)

        assertEquals(Destination.HOME, viewModel.state.value.destination)
    }

    @Test
    fun `state reports the worst slice status, not an arbitrary one`() {
        // One failed read matters even when everything else is fine.
        val healthy = VaultUiState.of(FamilyMember.VICTOR)
        assertEquals(Freshness.LIVE, healthy.worstStatus)

        val broken = VaultUiState.of(FamilyMember.VICTOR, status = Freshness.ERROR)
        assertEquals(Freshness.ERROR, broken.worstStatus)

        val stale = VaultUiState.of(FamilyMember.VICTOR, status = Freshness.STALE)
        assertEquals(Freshness.STALE, stale.worstStatus)
    }
}
