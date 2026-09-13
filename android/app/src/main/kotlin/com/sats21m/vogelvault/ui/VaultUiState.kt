package com.sats21m.vogelvault.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.FinanceDocumentSnapshot
import com.sats21m.vogelvault.data.FinanceReadSource
import com.sats21m.vogelvault.data.LoadedFinanceRead
import com.sats21m.vogelvault.data.MarketQuoteReadSnapshot
import com.sats21m.vogelvault.data.RowReadDiagnostic
import com.sats21m.vogelvault.data.RowReadFailure
import com.sats21m.vogelvault.data.RowReadProjection
import com.sats21m.vogelvault.data.cache.CachedReadModel
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.rowReadDiagnostics
import com.sats21m.vogelvault.data.toRowReadFailure
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceDocument
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
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
    /** A row or finance read rejected the active credential. */
    val staleAuthorization: Boolean = false,
    internal val rowUnauthorized: Boolean = staleAuthorization,
    internal val financeUnauthorized: Boolean = false,
    /** Fixed, non-secret explanation when enabling authenticated reads fails. */
    val remoteConfigurationError: String? = null,
    /** Projection-aware, non-secret diagnoses retained before stale-cache substitution. */
    val rowReadDiagnostics: Set<RowReadDiagnostic> = data.rowReadDiagnostics,
    /** Client-owned finance document; never inferred from legacy BTC rows. */
    val financeDocument: FinanceDocument? = null,
    val financeStatus: Freshness = Freshness.EMPTY,
    /** BTC, VOO, and IBIT quote snapshot. Null means no complete snapshot arrived. */
    val marketQuotes: MarketQuoteSnapshot? = null,
    val marketQuoteStatus: Freshness = Freshness.EMPTY,
    val financeReadDiagnostics: Set<RowReadDiagnostic> = emptySet(),
) {
    val switchTargets: List<FamilyMember> get() = activeProfile.gatedSwitchTargets

    /**
     * The most actionable cause for a single UI notice.
     *
     * The full set remains available above when different projections fail for
     * different reasons.
     */
    val primaryRowReadDiagnostic: RowReadDiagnostic?
        get() {
            val diagnostics = rowReadDiagnostics + financeReadDiagnostics
            return FAILURE_DISPLAY_ORDER.firstNotNullOfOrNull { failure ->
                diagnostics.firstOrNull { it.failure == failure }
            }
        }

    val primaryRowReadFailure: RowReadFailure?
        get() = primaryRowReadDiagnostic?.failure

    /** Compatibility cause-only aggregation. */
    val rowReadFailures: Set<RowReadFailure>
        get() = (rowReadDiagnostics + financeReadDiagnostics)
            .mapTo(linkedSetOf()) { it.failure }

    val rowReadFailureTitleRes: Int?
        get() = primaryRowReadFailure?.titleRes

    val rowReadFailureDetailRes: Int?
        get() = primaryRowReadFailure?.detailRes

    val rowReadFailureProjectionRes: Int?
        get() = primaryRowReadDiagnostic?.projection?.labelRes

    /**
     * Months the Budget screen may scope to, newest first.
     *
     * Derived from this profile's narrow budget scope, never from the wider
     * oversight ledger: Mason's months must not appear because an adult happens
     * to be looking, and Rachel must get the same list as Victor.
     */
    val budgetMonths: List<String>
        get() = data.transactions.value.budgetMonthsFor(
            activeProfile,
            data.budget.value?.month,
            data.btcBillPays.value,
        )

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
        get() = listOf(
            data.transactions.status to data.transactions.updatedAt,
            data.budget.status to data.budget.updatedAt,
            data.btcAccounts.status to data.btcAccounts.updatedAt,
            data.btcBuys.status to data.btcBuys.updatedAt,
            data.todos.status to data.todos.updatedAt,
            data.income.status to data.income.updatedAt,
            data.btcBalance.status to data.btcBalance.updatedAt,
            data.btcBillPays.status to data.btcBillPays.updatedAt,
            financeStatus to financeDocument?.updatedAtMs,
            marketQuoteStatus to null,
        )

    private val hasArrivedData: Boolean
        get() =
            data.transactions.value.isNotEmpty() ||
                data.budget.value != null ||
                data.btcAccounts.value.isNotEmpty() ||
                data.btcBuys.value.isNotEmpty() ||
                data.todos.value.isNotEmpty() ||
                data.income.value.isNotEmpty() ||
                data.btcBalance.value != null ||
                data.btcBillPays.value.isNotEmpty() ||
                financeDocument != null ||
                marketQuotes != null

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
    private val financeSource: FinanceReadSource? = null,
    remoteInitiallyEnabled: Boolean = rowSource != null || financeSource != null,
    effectiveReadReady: StateFlow<Boolean>? = null,
    private val enableRemote: ((String) -> Unit)? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val observeEffectiveReadReady = effectiveReadReady != null
    private val readReady = effectiveReadReady ?: MutableStateFlow(remoteInitiallyEnabled)

    private val _state = MutableStateFlow(
        if (!readReady.value) {
            VaultUiState(now = clock())
        } else {
            VaultUiState(data = loadingModel(FamilyMember.VICTOR), now = clock())
        },
    )
    val state: StateFlow<VaultUiState> = _state.asStateFlow()
    private var rowJob: Job? = null
    private var appliedReadReady = readReady.value
    private var cachedModel: CachedReadModel? = null
    private var liveModel: ReadModel? = null
    private var liveUnauthorized = false
    private var loadGeneration = 0L

    init {
        if (readReady.value && (rowSource != null || financeSource != null)) {
            connectRows(FamilyMember.VICTOR)
        }
        if (observeEffectiveReadReady) {
            viewModelScope.launch {
                readReady.collect { ready ->
                    if (ready == appliedReadReady) return@collect
                    appliedReadReady = ready
                    if (ready) {
                        activateRemoteRows()
                    } else {
                        deactivateRemoteRows()
                    }
                }
            }
        }
    }

    fun navigate(destination: Destination) {
        _state.update { current ->
            if (destination in destinationsFor(current.activeProfile)) current.copy(destination = destination) else current
        }
    }

    fun switchProfile(next: FamilyMember) = switchProfile(next, authorized = false)

    /** Called only by the shell's authorized-switch callback. */
    internal fun switchAuthorizedProfile(next: FamilyMember) = switchProfile(next, authorized = true)

    private fun switchProfile(next: FamilyMember, authorized: Boolean) {
        _state.update { current ->
            val targets = if (authorized) {
                current.activeProfile.gatedSwitchTargets
            } else {
                current.activeProfile.allowedSwitchTargets
            }
            if (next !in targets) return@update current

            current.copy(
                activeProfile = next,
                destination = current.destination.takeIf { it in destinationsFor(next) } ?: Destination.DASHBOARD,
                data = if (!readReady.value) Fixtures.envelope(next) else loadingModel(next),
                financeDocument = null,
                financeStatus = if (readReady.value) Freshness.LOADING else Freshness.EMPTY,
                marketQuotes = null,
                marketQuoteStatus = if (readReady.value) Freshness.LOADING else Freshness.EMPTY,
                financeReadDiagnostics = emptySet(),
                staleAuthorization = false,
                rowUnauthorized = false,
                financeUnauthorized = false,
                rowReadDiagnostics = emptySet(),
                // A month picked against one profile's ledger means nothing on the
                // next one, so the scope goes back to that profile's budget month.
                selectedMonth = null,
            )
        }
        if (
            readReady.value &&
            (rowSource != null || financeSource != null) &&
            _state.value.activeProfile == next
        ) {
            connectRows(next)
        }
    }

    /**
     * Reloads the active profile after an accepted write without pretending the
     * user switched profiles.
     *
     * A real switch clears profile-scoped navigation state and replaces the
     * current rows with a loading projection. A write refresh keeps both the
     * screen state and its last trustworthy rows visible until the reload lands.
     */
    fun refreshActiveProfile() {
        if (!readReady.value || (rowSource == null && financeSource == null)) return
        connectRows(_state.value.activeProfile)
    }

    fun simulate(status: Freshness) {
        _state.update {
            it.copy(
                data = Fixtures.envelope(it.activeProfile, status),
                rowReadDiagnostics = emptySet(),
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
        if (!readReady.value) {
            _state.update {
                it.copy(remoteConfigurationError = REMOTE_CONFIGURATION_ERROR)
            }
            return
        }
        enableStoredRemoteRows()
    }

    /** Activates a credential that was already committed by the bootstrap repository. */
    fun enableStoredRemoteRows() {
        if (!readReady.value) return
        appliedReadReady = true
        activateRemoteRows()
    }

    private fun activateRemoteRows() {
        val profile = _state.value.activeProfile
        _state.update {
            it.copy(
                data = loadingModel(profile),
                financeDocument = null,
                financeStatus = Freshness.LOADING,
                marketQuotes = null,
                marketQuoteStatus = Freshness.LOADING,
                financeReadDiagnostics = emptySet(),
                remoteConfigurationError = null,
                staleAuthorization = false,
                rowUnauthorized = false,
                financeUnauthorized = false,
                rowReadDiagnostics = emptySet(),
            )
        }
        if (rowSource != null || financeSource != null) connectRows(profile)
    }

    private fun deactivateRemoteRows() {
        loadGeneration += 1
        rowJob?.cancel()
        rowJob = null
        cachedModel = null
        liveModel = null
        liveUnauthorized = false
        _state.update { current ->
            current.copy(
                data = Fixtures.envelope(current.activeProfile),
                financeDocument = null,
                financeStatus = Freshness.EMPTY,
                marketQuotes = null,
                marketQuoteStatus = Freshness.EMPTY,
                financeReadDiagnostics = emptySet(),
                remoteConfigurationError = null,
                staleAuthorization = false,
                rowUnauthorized = false,
                financeUnauthorized = false,
                rowReadDiagnostics = emptySet(),
            )
        }
    }

    private fun connectRows(profile: FamilyMember) {
        if (!readReady.value) return
        val generation = ++loadGeneration
        rowJob?.cancel()
        cachedModel = null
        liveModel = null
        liveUnauthorized = false
        rowJob =
            viewModelScope.launch load@{
                launch { loadFinance(profile, generation) }
                val source = rowSource ?: return@load
                launch {
                    source.observe(profile).collect { cached ->
                        if (!isCurrentLoad(profile, generation)) return@collect
                        cachedModel = cached
                        _state.update { current ->
                            if (!isCurrentLoad(current, profile, generation)) {
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
                                    rowUnauthorized = unauthorized,
                                    staleAuthorization = unauthorized || current.financeUnauthorized,
                                    rowReadDiagnostics = live?.rowReadDiagnostics.orEmpty(),
                                )
                            }
                        }
                    }
                }
                val loaded = withContext(Dispatchers.Default) { source.load(profile) }
                if (!isCurrentLoad(profile, generation)) return@load
                liveModel = loaded.data
                liveUnauthorized = loaded.unauthorized
                _state.update { current ->
                    if (!isCurrentLoad(current, profile, generation)) {
                        current
                    } else {
                        // Financial snapshots rejected by authorization are
                        // intentionally hidden, even when Room has stale rows.
                        // Other failures may use stale cache fallback because
                        // they do not invalidate the viewer's right to see it.
                        val cached = cachedModel?.takeUnless { loaded.unauthorized }
                        current.copy(
                            data = loaded.data.withCacheFallback(cached?.data),
                            staleAuthorization = loaded.unauthorized || current.financeUnauthorized,
                            rowUnauthorized = loaded.unauthorized,
                            rowReadDiagnostics = loaded.data.rowReadDiagnostics,
                            now = clock(),
                        )
                    }
                }
            }
    }

    private suspend fun loadFinance(
        profile: FamilyMember,
        generation: Long,
    ) {
        val source = financeSource ?: return
        _state.update { current ->
            if (!isCurrentLoad(current, profile, generation)) current else current.copy(
                financeStatus = Freshness.LOADING,
                marketQuoteStatus = Freshness.LOADING,
            )
        }
        val loaded = source.load(profile)
        if (!isCurrentLoad(profile, generation)) return
        val next = financeSurfaceState(loaded)
        _state.update { current ->
            if (!isCurrentLoad(current, profile, generation)) current else current.copy(
                financeDocument = next.financeDocument,
                financeStatus = next.financeStatus,
                marketQuotes = next.marketQuotes,
                marketQuoteStatus = next.marketQuoteStatus,
                financeReadDiagnostics = next.readDiagnostics,
                financeUnauthorized = next.unauthorized,
                staleAuthorization = current.rowUnauthorized || next.unauthorized,
                now = clock(),
            )
        }
    }

    private fun isCurrentLoad(
        profile: FamilyMember,
        generation: Long,
    ): Boolean =
        readReady.value &&
            loadGeneration == generation &&
            _state.value.activeProfile == profile

    private fun isCurrentLoad(
        state: VaultUiState,
        profile: FamilyMember,
        generation: Long,
    ): Boolean =
        readReady.value &&
            loadGeneration == generation &&
            state.activeProfile == profile

    private companion object {
        const val REMOTE_CONFIGURATION_ERROR =
            "Authenticated row reads could not be saved securely. Remote reads remain disabled."
    }
}

internal data class FinanceSurfaceState(
    val financeDocument: FinanceDocument?,
    val financeStatus: Freshness,
    val marketQuotes: MarketQuoteSnapshot?,
    val marketQuoteStatus: Freshness,
    val readDiagnostics: Set<RowReadDiagnostic>,
    val unauthorized: Boolean,
)

internal fun financeSurfaceState(loaded: LoadedFinanceRead): FinanceSurfaceState =
    financeSurfaceState(loaded.finance, loaded.quotes, loaded.unauthorized)

internal fun financeSurfaceState(
    finance: ConvexResult<FinanceDocumentSnapshot>,
    quotes: ConvexResult<MarketQuoteReadSnapshot>,
    unauthorized: Boolean =
        finance === ConvexResult.Unauthorized || quotes === ConvexResult.Unauthorized,
): FinanceSurfaceState {
    val financeValue = (finance as? ConvexResult.Ok)?.value
    val quoteValue = (quotes as? ConvexResult.Ok)?.value
    return FinanceSurfaceState(
        financeDocument = financeValue?.document?.takeIf { financeValue.complete },
        financeStatus = when {
            financeValue == null -> Freshness.ERROR
            !financeValue.complete -> Freshness.ERROR
            financeValue.document == null -> Freshness.EMPTY
            else -> Freshness.LIVE
        },
        marketQuotes = quoteValue?.snapshot?.takeIf { quoteValue.complete },
        marketQuoteStatus = when {
            quoteValue == null -> Freshness.ERROR
            !quoteValue.complete -> Freshness.ERROR
            else -> Freshness.LIVE
        },
        readDiagnostics = buildSet {
            if (finance !is ConvexResult.Ok && finance !== ConvexResult.Missing) {
                add(RowReadDiagnostic(RowReadProjection.FINANCE, finance.toRowReadFailure()))
            } else if (financeValue?.complete == false) {
                add(
                    RowReadDiagnostic(
                        RowReadProjection.FINANCE,
                        RowReadFailure.MALFORMED_PAYLOAD,
                    ),
                )
            }
            if (quotes !is ConvexResult.Ok) {
                add(
                    RowReadDiagnostic(
                        RowReadProjection.MARKET_QUOTES,
                        quotes.toRowReadFailure(),
                    ),
                )
            } else if (!quotes.value.complete) {
                add(
                    RowReadDiagnostic(
                        RowReadProjection.MARKET_QUOTES,
                        RowReadFailure.MALFORMED_PAYLOAD,
                    ),
                )
            }
        },
        unauthorized = unauthorized,
    )
}

private val FAILURE_DISPLAY_ORDER =
    listOf(
        RowReadFailure.UNAUTHORIZED,
        RowReadFailure.DISABLED,
        RowReadFailure.NOT_CONFIGURED,
        RowReadFailure.DEPLOYMENT_MISCONFIGURED,
        RowReadFailure.SERVER_REJECTED,
        RowReadFailure.MALFORMED_PAYLOAD,
        RowReadFailure.HTTP,
        RowReadFailure.TRANSPORT,
    )

private val RowReadFailure.titleRes: Int
    get() = when (this) {
        RowReadFailure.UNAUTHORIZED -> R.string.convex_row_failure_unauthorized_title
        RowReadFailure.DISABLED -> R.string.convex_row_failure_disabled_title
        RowReadFailure.NOT_CONFIGURED -> R.string.convex_row_failure_not_configured_title
        RowReadFailure.TRANSPORT -> R.string.convex_row_failure_transport_title
        RowReadFailure.HTTP -> R.string.convex_row_failure_http_title
        RowReadFailure.DEPLOYMENT_MISCONFIGURED ->
            R.string.convex_row_failure_deployment_misconfigured_title
        RowReadFailure.SERVER_REJECTED -> R.string.convex_row_failure_server_rejected_title
        RowReadFailure.MALFORMED_PAYLOAD -> R.string.convex_row_failure_malformed_payload_title
    }

private val RowReadFailure.detailRes: Int
    get() = when (this) {
        RowReadFailure.UNAUTHORIZED -> R.string.convex_row_failure_unauthorized_detail
        RowReadFailure.DISABLED -> R.string.convex_row_failure_disabled_detail
        RowReadFailure.NOT_CONFIGURED -> R.string.convex_row_failure_not_configured_detail
        RowReadFailure.TRANSPORT -> R.string.convex_row_failure_transport_detail
        RowReadFailure.HTTP -> R.string.convex_row_failure_http_detail
        RowReadFailure.DEPLOYMENT_MISCONFIGURED ->
            R.string.convex_row_failure_deployment_misconfigured_detail
        RowReadFailure.SERVER_REJECTED -> R.string.convex_row_failure_server_rejected_detail
        RowReadFailure.MALFORMED_PAYLOAD -> R.string.convex_row_failure_malformed_payload_detail
    }

private val RowReadProjection.labelRes: Int
    get() = when (this) {
        RowReadProjection.TRANSACTIONS -> R.string.convex_projection_transactions
        RowReadProjection.BUDGET -> R.string.convex_projection_budget
        RowReadProjection.BITCOIN_ACCOUNTS -> R.string.convex_projection_bitcoin_accounts
        RowReadProjection.BITCOIN_BUYS -> R.string.convex_projection_bitcoin_buys
        RowReadProjection.TODOS -> R.string.convex_projection_todos
        RowReadProjection.INCOME -> R.string.convex_projection_income
        RowReadProjection.BITCOIN_BALANCE -> R.string.convex_projection_bitcoin_balance
        RowReadProjection.BITCOIN_BILL_PAYS -> R.string.convex_projection_bitcoin_bill_pays
        RowReadProjection.FINANCE -> R.string.convex_projection_finance
        RowReadProjection.MARKET_QUOTES -> R.string.convex_projection_market_quotes
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
