package com.sats21m.vogelvault.ui

import androidx.lifecycle.ViewModel
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Everything the UI reads.
 *
 * Immutable and constructible directly, so screenshot tests and previews can
 * render any profile/state combination without a ViewModel or a coroutine.
 */
data class VaultUiState(
    val activeProfile: FamilyMember = FamilyMember.VICTOR,
    val destination: Destination = Destination.DASHBOARD,
    val data: ReadModel = Fixtures.envelope(FamilyMember.VICTOR),
    val now: Long = Fixtures.NOW_MILLIS,
    /**
     * Month the Budget screen opens on, or null to follow the budget file.
     *
     * The live selection is remembered by the screen — this is the seed, so the
     * design packet and previews can render an off-default month without driving
     * a tap.
     */
    val selectedMonth: String? = null,
) {
    val switchTargets: List<FamilyMember> get() = activeProfile.allowedSwitchTargets

    /**
     * Months the Budget screen may scope to, newest first.
     *
     * Derived from this profile's narrow budget scope, never from the wider
     * oversight ledger: Mason's months must not appear because an adult happens
     * to be looking, and Rachel must get the same list as Victor.
     */
    val budgetMonths: List<String>
        get() = data.transactions.value.budgetMonthsFor(activeProfile, data.budget.value?.month)

    /**
     * The month the Budget screen should open on, or null when there is nothing
     * to scope.
     *
     * A seeded month that this profile has no data for falls back rather than
     * rendering an empty screen — a bad seed should look wrong, not look like a
     * month with no spending.
     */
    val activeBudgetMonth: String?
        get() = resolveBudgetMonth(selectedMonth, budgetMonths, data.budget.value?.month)

    private val slices
        get() = listOf(data.transactions.status to data.transactions.updatedAt,
            data.budget.status to data.budget.updatedAt,
            data.btcAccounts.status to data.btcAccounts.updatedAt,
            data.btcBuys.status to data.btcBuys.updatedAt,
            data.todos.status to data.todos.updatedAt)

    /**
     * Worst status across every slice, for the global SYNC indicator.
     *
     * One failed read matters even when the rest are fine, so this reports the
     * worst rather than an arbitrary slice.
     */
    val worstStatus: Freshness
        get() = slices.minByOrNull { severity(it.first) }?.first ?: Freshness.EMPTY

    val worstUpdatedAt: Long?
        get() = slices.minByOrNull { severity(it.first) }?.second

    private fun severity(status: Freshness): Int = when (status) {
        Freshness.ERROR -> 0
        Freshness.LOADING -> 1
        Freshness.STALE -> 2
        Freshness.EMPTY -> 3
        Freshness.LIVE -> 4
    }

    companion object {
        /** Build state for a profile and slice status. Used by tests and previews. */
        fun of(
            profile: FamilyMember,
            destination: Destination = Destination.DASHBOARD,
            status: Freshness = Freshness.LIVE,
            selectedMonth: String? = null,
        ): VaultUiState = VaultUiState(
            activeProfile = profile,
            destination = destination,
            data = Fixtures.envelope(profile, status),
            selectedMonth = selectedMonth,
        )
    }
}

class VaultViewModel : ViewModel() {

    private val _state = MutableStateFlow(VaultUiState())
    val state: StateFlow<VaultUiState> = _state.asStateFlow()

    fun navigate(destination: Destination) {
        _state.update { current ->
            // Refuse a destination this profile may not open, rather than
            // rendering it and relying on the shell to catch it.
            if (destination in Destination.visibleTo(current.activeProfile)) {
                current.copy(destination = destination)
            } else {
                current
            }
        }
    }

    fun switchProfile(next: FamilyMember) {
        _state.update { current ->
            // Enforced here as well as in the UI: a child profile must not be able
            // to reach an adult one even if the control is bypassed.
            if (next !in current.activeProfile.allowedSwitchTargets) return@update current

            val destinations = Destination.visibleTo(next)
            current.copy(
                activeProfile = next,
                data = Fixtures.envelope(next),
                // A month picked against one profile's ledger means nothing on the
                // next one, so the scope goes back to that profile's budget month.
                selectedMonth = null,
                destination = if (current.destination in destinations) {
                    current.destination
                } else {
                    Destination.DASHBOARD
                },
            )
        }
    }

    fun simulate(status: Freshness) {
        _state.update { it.copy(data = Fixtures.envelope(it.activeProfile, status)) }
    }
}
