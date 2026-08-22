package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.UNFOLDED_MIN_WIDTH_DP
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.foldedOverflowDestinations
import com.sats21m.vogelvault.ui.foldedPrimaryDestinations
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
    fun `retirement and net worth remain separate navigation destinations`() {
        assertTrue(Destination.RETIREMENT in Destination.entries)
        assertTrue(Destination.NET_WORTH in Destination.entries)
    }

    @Test
    fun `folded navigation partitions every destination into primary or More`() {
        val destinations = Destination.entries.toList()
        val primary = foldedPrimaryDestinations(destinations)
        val overflow = foldedOverflowDestinations(destinations)

        assertEquals(4, primary.size)
        assertEquals(
            listOf(
                Destination.BTC_BUYS,
                Destination.BTC_BILL_PAYS,
                Destination.NET_WORTH,
                Destination.RETIREMENT,
                Destination.EXPORT,
                Destination.TODAY,
                Destination.TASKS,
                Destination.FAMILY,
                Destination.SETTINGS,
            ),
            overflow,
        )
        assertEquals(destinations, primary + overflow)
        assertEquals(destinations.size, (primary + overflow).distinct().size)
        assertTrue(Destination.SETTINGS in overflow)
    }

    @Test
    fun `folded navigation does not add More when all destinations fit`() {
        val destinations = Destination.entries.take(5)

        assertEquals(destinations, foldedPrimaryDestinations(destinations))
        assertTrue(foldedOverflowDestinations(destinations).isEmpty())
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
    fun `children can navigate every child-scoped destination`() {
        for (child in listOf(FamilyMember.MASON, FamilyMember.MADDOX)) {
            val viewModel = VaultViewModel(remoteInitiallyEnabled = false)
            viewModel.switchProfile(child)

            for (destination in Destination.entries) {
                viewModel.navigate(destination)
                assertEquals(destination, viewModel.state.value.destination, "$child could not open $destination")
            }
        }
    }

    @Test
    fun `profile switching preserves the current child-scoped destination`() {
        val viewModel = VaultViewModel(remoteInitiallyEnabled = false)
        viewModel.navigate(Destination.SETTINGS)

        viewModel.switchProfile(FamilyMember.MASON)

        assertEquals(Destination.SETTINGS, viewModel.state.value.destination)
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
