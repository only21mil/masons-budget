package com.sats21m.vogelvault.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.RowReadFailure
import com.sats21m.vogelvault.data.cache.CachedReadModel
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.rowReadFailures
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    /** A rejected read token invalidated the last complete Room snapshot. */
    val staleAuthorization: Boolean = false,
    /** Fixed, non-secret explanation when enabling authenticated reads fails. */
    val remoteConfigurationError: String? = null,
    /** Distinct, non-secret causes retained before any stale-cache substitution. */
    val rowReadFailures: Set<RowReadFailure> = data.rowReadFailures,
) {
    val switchTargets: List<FamilyMember> get() = activeProfile.allowedSwitchTargets

    /**
     * The most actionable cause for a single UI notice.
     *
     * The full set remains available above when different projections fail for
     * different reasons.
     */
    val primaryRowReadFailure: RowReadFailure?
        get() = FAILURE_DISPLAY_ORDER.firstOrNull(rowReadFailures::contains)

    val rowReadFailureTitleRes: Int?
        get() = primaryRowReadFailure?.titleRes

    val rowReadFailureDetailRes: Int?
        get() = primaryRowReadFailure?.detailRes

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

    private val hasArrivedData: Boolean
        get() =
            data.transactions.value.isNotEmpty() ||
                data.budget.value != null ||
                data.btcAccounts.value.isNotEmpty() ||
                data.btcBuys.value.isNotEmpty() ||
                data.todos.value.isNotEmpty()

    /**
     * Empty slices do not disown rows that arrived in another slice.
     *
     * In particular, migrated rows may legitimately carry updatedAtMs = 0. The
     * global pill is based on actual values, never on a positive timestamp.
     */
    private val statusSlices
        get() =
            if (hasArrivedData) {
                slices.filterNot { it.first == Freshness.EMPTY }
            } else {
                slices
            }

    /**
     * Worst status across every slice, for the global SYNC indicator.
     *
     * One failed read matters even when the rest are fine, so this reports the
     * worst rather than an arbitrary slice.
     */
    val worstStatus: Freshness
        get() = statusSlices.minByOrNull { severity(it.first) }?.first ?: Freshness.EMPTY

    val worstUpdatedAt: Long?
        get() = statusSlices.minByOrNull { severity(it.first) }?.second

    private fun severity(status: Freshness): Int = when (status) {
        Freshness.ERROR -> 0
        Freshness.LOADING -> 1
        Freshness.STALE -> 2
        Freshness.DEMO -> 3
        Freshness.EMPTY -> 4
        Freshness.LIVE -> 5
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

class VaultViewModel(
    private val rowSource: CachedRowDataSource? = null,
    remoteInitiallyEnabled: Boolean = rowSource != null,
    private val enableRemote: ((String) -> Unit)? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val _state = MutableStateFlow(
        if (!remoteInitiallyEnabled) {
            VaultUiState(now = clock())
        } else {
            VaultUiState(data = loadingModel(FamilyMember.VICTOR), now = clock())
        },
    )
    val state: StateFlow<VaultUiState> = _state.asStateFlow()
    private var rowJob: Job? = null
    private var remoteEnabled = remoteInitiallyEnabled
    private var cachedModel: CachedReadModel? = null
    private var liveModel: ReadModel? = null
    private var liveUnauthorized = false

    init {
        if (rowSource != null && remoteInitiallyEnabled) connectRows(FamilyMember.VICTOR)
    }

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
                data = if (!remoteEnabled) Fixtures.envelope(next) else loadingModel(next),
                staleAuthorization = false,
                rowReadFailures = emptySet(),
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
        if (remoteEnabled && rowSource != null && _state.value.activeProfile == next) connectRows(next)
    }

    fun simulate(status: Freshness) {
        _state.update {
            it.copy(
                data = Fixtures.envelope(it.activeProfile, status),
                rowReadFailures = emptySet(),
            )
        }
    }

    fun enableRemoteRows(readToken: String) {
        if (readToken.isBlank()) return
        val configure =
            enableRemote ?: run {
                _state.update {
                    it.copy(remoteConfigurationError = REMOTE_CONFIGURATION_ERROR)
                }
                return
            }
        try {
            configure(readToken)
        } catch (_: Exception) {
            _state.update {
                it.copy(remoteConfigurationError = REMOTE_CONFIGURATION_ERROR)
            }
            return
        }
        remoteEnabled = true
        val profile = _state.value.activeProfile
        _state.update {
            it.copy(
                data = loadingModel(profile),
                remoteConfigurationError = null,
                rowReadFailures = emptySet(),
            )
        }
        connectRows(profile)
    }

    private fun connectRows(profile: FamilyMember) {
        val source = rowSource ?: return
        rowJob?.cancel()
        cachedModel = null
        liveModel = null
        liveUnauthorized = false
        rowJob =
            viewModelScope.launch {
                launch {
                    source.observe(profile).collect { cached ->
                        cachedModel = cached
                        _state.update { current ->
                            if (current.activeProfile != profile) {
                                current
                            } else {
                                val unauthorized = liveUnauthorized || cached.staleAuthorization
                                val live = liveModel
                                current.copy(
                                    data =
                                        when {
                                            live == null -> cached.data
                                            unauthorized -> live
                                            else -> live.withCacheFallback(cached.data)
                                        },
                                    staleAuthorization = unauthorized,
                                    rowReadFailures = live?.rowReadFailures.orEmpty(),
                                )
                            }
                        }
                    }
                }
                val loaded = withContext(Dispatchers.Default) { source.load(profile) }
                liveModel = loaded.data
                liveUnauthorized = loaded.unauthorized
                _state.update { current ->
                    if (current.activeProfile != profile) {
                        current
                    } else {
                        // Financial snapshots rejected by authorization are
                        // intentionally hidden, even when Room has stale rows.
                        // Other failures may use stale cache fallback because
                        // they do not invalidate the viewer's right to see it.
                        val cached = cachedModel?.takeUnless { loaded.unauthorized }
                        current.copy(
                            data = loaded.data.withCacheFallback(cached?.data),
                            staleAuthorization = loaded.unauthorized,
                            rowReadFailures = loaded.data.rowReadFailures,
                            now = clock(),
                        )
                    }
                }
            }
    }

    private companion object {
        const val REMOTE_CONFIGURATION_ERROR =
            "Authenticated row reads could not be saved securely. Remote reads remain disabled."
    }
}

private val FAILURE_DISPLAY_ORDER =
    listOf(
        RowReadFailure.UNAUTHORIZED,
        RowReadFailure.DISABLED,
        RowReadFailure.NOT_CONFIGURED,
        RowReadFailure.MALFORMED_PAYLOAD,
        RowReadFailure.TRANSPORT,
    )

private val RowReadFailure.titleRes: Int
    get() = when (this) {
        RowReadFailure.UNAUTHORIZED -> R.string.convex_row_failure_unauthorized_title
        RowReadFailure.DISABLED -> R.string.convex_row_failure_disabled_title
        RowReadFailure.NOT_CONFIGURED -> R.string.convex_row_failure_not_configured_title
        RowReadFailure.TRANSPORT -> R.string.convex_row_failure_transport_title
        RowReadFailure.MALFORMED_PAYLOAD -> R.string.convex_row_failure_malformed_payload_title
    }

private val RowReadFailure.detailRes: Int
    get() = when (this) {
        RowReadFailure.UNAUTHORIZED -> R.string.convex_row_failure_unauthorized_detail
        RowReadFailure.DISABLED -> R.string.convex_row_failure_disabled_detail
        RowReadFailure.NOT_CONFIGURED -> R.string.convex_row_failure_not_configured_detail
        RowReadFailure.TRANSPORT -> R.string.convex_row_failure_transport_detail
        RowReadFailure.MALFORMED_PAYLOAD -> R.string.convex_row_failure_malformed_payload_detail
    }

private fun loadingModel(profile: FamilyMember): ReadModel {
    val empty = Fixtures.envelope(profile, Freshness.EMPTY)
    fun <T> loading(slice: com.sats21m.vogelvault.domain.Slice<T>) =
        slice.copy(status = Freshness.LOADING, source = "Convex rows", updatedAt = null)
    return empty.copy(
        transactions = loading(empty.transactions),
        budget = loading(empty.budget),
        btcAccounts = loading(empty.btcAccounts),
        btcBuys = loading(empty.btcBuys),
        todos = loading(empty.todos),
        btcPriceCents = 0L,
    )
}

private fun ReadModel.withCacheFallback(cached: ReadModel?): ReadModel {
    if (cached == null) return this

    fun <T> com.sats21m.vogelvault.domain.Slice<T>.fallbackTo(
        fallback: com.sats21m.vogelvault.domain.Slice<T>,
    ) = if (status == Freshness.ERROR && fallback.status == Freshness.STALE) fallback else this

    return copy(
        transactions = transactions.fallbackTo(cached.transactions),
        budget = budget.fallbackTo(cached.budget),
        btcAccounts = btcAccounts.fallbackTo(cached.btcAccounts),
        btcBuys = btcBuys.fallbackTo(cached.btcBuys),
        todos = todos.fallbackTo(cached.todos),
    )
}
