package com.sats21m.vogelvault

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexReadBootstrapRepository
import com.sats21m.vogelvault.data.FinanceQueryRepositories
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecoveringFinanceReadSource
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.SecureConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.SecureConvexSyncTokenSource
import com.sats21m.vogelvault.data.ReadBootstrapStatus
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.cache.VaultDatabase
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.BtcBillPayMutationGateway
import com.sats21m.vogelvault.ui.BtcBuyIncomeMutationGateway
import com.sats21m.vogelvault.ui.ConvexTransactionActions
import com.sats21m.vogelvault.ui.BtcTransferMutationGateway
import com.sats21m.vogelvault.ui.PaymentSourceStore
import com.sats21m.vogelvault.ui.TransactionDeviceMutationGateway
import com.sats21m.vogelvault.ui.TodoMutationGateway
import com.sats21m.vogelvault.ui.VaultViewModel
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Application-owned identity leases for drafts awaiting a definitive server
 * acceptance, one pending id per caller-provided lease scope. Ambiguous retries
 * deliberately reuse the scope's id so Convex supersedes the same row instead
 * of inserting another one. When backed by preferences, leases survive process
 * death. Each lease scope keeps pending ids independent across surfaces and
 * profiles. Pre-scope Bitcoin-buy markers are deliberately ignored because
 * their missing surface and profile identity makes safe ownership impossible.
 *
 * The scope is usually the server's natural source-file idempotency domain, but
 * Bitcoin buys need a narrower explicit scope because standalone and
 * income-linked writes can share a source file and adult profiles share the
 * canonical Victor owner. Callers must use the same scope for acquisition and
 * compare-and-clear release.
 */
internal class TransactionDraftIdStore(
    private val preferences: SharedPreferences? = null,
) {
    private val lock = Any()
    private val pendingIdsByScope =
        preferences
            ?.all
            ?.mapNotNull { (scope, value) ->
                (value as? String)?.let { pendingId -> scope to pendingId }
            }
            ?.toMap()
            ?.toMutableMap()
            ?: mutableMapOf()

    fun currentId(scope: String): String = synchronized(lock) {
        pendingIdsByScope[scope]
            ?: "android-${UUID.randomUUID()}".also { pendingId ->
                if (preferences != null) {
                    check(preferences.edit().putString(scope, pendingId).commit()) {
                        "pending draft id could not be persisted"
                    }
                }
                pendingIdsByScope[scope] = pendingId
            }
    }

    /**
     * Compare-and-clear within one scope: releases the scope's pending id only
     * when it is still the id that was accepted.
     *
     * A blind clear loses a race. Two overlapping requests can carry the same
     * id X (dismiss, reopen, retry before the first returns) and Convex accepts
     * both idempotently. The first Ok clears X, the user starts the next
     * operation and takes Y, then the delayed second Ok arrives — a blind clear
     * would drop Y even though nothing accepted it, and the operation after
     * that would mint a third id and duplicate the row. Scoping the clear stops
     * the cross-profile variant: an acceptance under one sourceFile can never
     * release another sourceFile's lease, even for an equal id.
     */
    fun rotateAfterAcceptance(scope: String, acceptedId: String) {
        synchronized(lock) {
            if (pendingIdsByScope[scope] != acceptedId) return
            val removed = preferences?.edit()?.remove(scope)?.commit() ?: true
            if (removed) {
                pendingIdsByScope.remove(scope)
            }
        }
    }
}

/**
 * Process-scoped infrastructure and the ViewModel composition root.
 *
 * Dependencies remain lazy so a disabled/unconfigured build never opens a
 * Convex socket on startup.
 */
open class VaultApplication : Application() {
    /**
     * Process-owned work that must outlive a transient Compose surface.
     * In-flight writes keep their receipt path even when their sheet leaves
     * composition; Android process death remains the outer cancellation bound.
     */
    internal open val applicationScope: CoroutineScope by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    }

    /** The selected payment-source wire survives Activity recreation. */
    internal open val paymentSourceStore: PaymentSourceStore by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        PaymentSourceStore(this)
    }

    /** Capability-scoped transaction writes for the Android add surface. */
    internal open val transactionDeviceMutationGateway: TransactionDeviceMutationGateway by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDeviceMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(writeConvexConfig()),
                credentialSource = SecureConvexDeviceCredentialSource(storedConvexConfigSource),
            ),
        )
    }

    /** Shared by every sheet instance until Convex confirms the pending row. */
    internal val transactionDraftIds: TransactionDraftIdStore by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDraftIdStore(
            getSharedPreferences(TRANSACTION_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE),
        )
    }

    /**
     * The Bitcoin buy sheet carries the same duplicate-credit hazard as the
     * transaction sheet: its buy credits River, so a dismissed-then-reopened
     * resubmit after an ambiguous write must reuse one id.
     */
    internal val btcBuyDraftIds: TransactionDraftIdStore by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDraftIdStore(
            getSharedPreferences(BTC_BUY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE),
        )
    }

    override fun onCreate() {
        super.onCreate()
        transactionDraftIds
        btcBuyDraftIds
        btcBillPayDraftIds
        btcTransferDraftIds
    }

    /** Stable retry ids for the one source-scoped Bitcoin bill-pay table. */
    internal val btcBillPayDraftIds: TransactionDraftIdStore by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDraftIdStore(
            getSharedPreferences(BTC_BILL_PAY_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE),
        )
    }

    /**
     * The Bitcoin transfer editor has the same duplicate-post hazard as buys:
     * a lost response must retry the exact same transfer id until Convex confirms
     * the idempotent row.
     */
    internal val btcTransferDraftIds: TransactionDraftIdStore by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        TransactionDraftIdStore(
            getSharedPreferences(BTC_TRANSFER_DRAFT_ID_PREFERENCES, Context.MODE_PRIVATE),
        )
    }

    /**
     * Process-owned acceptance signal for writes that may outlive the surface
     * that started them. `replay = 1` is the recreation guarantee: an Activity
     * recreated mid-write subscribes after the acceptance and still receives
     * it, so the visible ledger refreshes instead of staying stale until an
     * unrelated reload. Refresh consumers must be idempotent — a re-subscribe
     * after any past acceptance delivers one replayed signal.
     */
    private val acceptedWriteSignals = MutableSharedFlow<Unit>(
        replay = 1,
        extraBufferCapacity = 16,
    )
    val acceptedWrites: SharedFlow<Unit> = acceptedWriteSignals

    internal open fun noteAcceptedWrite() {
        acceptedWriteSignals.tryEmit(Unit)
    }

    override fun onTerminate() {
        applicationScope.cancel()
        super.onTerminate()
    }

    private companion object {
        const val TRANSACTION_DRAFT_ID_PREFERENCES = "transaction_draft_ids"
        const val BTC_BUY_DRAFT_ID_PREFERENCES = "btc_buy_draft_ids"
        const val BTC_BILL_PAY_DRAFT_ID_PREFERENCES = "btc_bill_pay_draft_ids"
        const val BTC_TRANSFER_DRAFT_ID_PREFERENCES = "btc_transfer_draft_ids"
    }

    val database: VaultDatabase by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        VaultDatabase.create(this)
    }

    private val convexConfigLock = Any()

    private val storedConvexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }

    /**
     * A valid manually entered credential is restored from encrypted storage.
     * Fresh installs and unusable stored state remain disabled until Settings
     * saves a credential.
     */
    val convexConfigSource: MutableConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        MutableConvexConfigSource(
            initial = initialConvexConfig(storedConvexConfigSource.current()),
        )
    }

    /** One non-secret source of truth for this process's effective read access. */
    internal open val effectiveReadReady: StateFlow<Boolean>
        get() = convexConfigSource.allowsRemoteRead

    private val readBootstrapRepository: ConvexReadBootstrapRepository by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        ConvexReadBootstrapRepository(
            stored = storedConvexConfigSource,
            effective = convexConfigSource,
            storageLock = convexConfigLock,
        )
    }

    /** Presence only; the generated bootstrap value never crosses into UI state. */
    internal open fun hasBundledReadBootstrap(): Boolean =
        bundledReadBootstrapPair().isNotEmpty()

    /** Claims and stores the generated one-time bootstrap without returning a secret. */
    internal open suspend fun connectBundledReadBootstrap(): ReadBootstrapStatus =
        readBootstrapRepository.connect(
            bundledPair = bundledReadBootstrapPair(),
            requestTodoWrite = bundledReadBootstrapRequestsTodoWrite(),
        )

    /**
     * Shared write transport. Every mutation reads the latest encrypted sync
     * token at request time; no write credential is baked into the app.
     */
    internal open val convexMutationClient: ConvexMutationClient by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        ConvexMutationClient(
            // The public deployment route is not a credential. Writes remain
            // available even when authenticated row reads are disabled.
            configSource = MutableConvexConfigSource(writeConvexConfig()),
            syncTokenSource = SecureConvexSyncTokenSource(storedConvexConfigSource),
        )
    }

    private val rowDataSource: CachedRowDataSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        CachedRowDataSource(
            remote = RowQueryRepositories.convex(convexConfigSource),
            dao = database.cacheDao(),
            configSource = convexConfigSource,
            onUnauthorized = ::recoverRejectedConvexConfig,
        )
    }

    /**
     * Edit and delete share the one write transport above, so they read the
     * latest encrypted sync token at request time. Constructing a second client
     * here would have no sync-token source and would stay fail-closed forever.
     */
    internal val transactionActions by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ConvexTransactionActions(convexMutationClient)
    }

    /** Capability-scoped todo writes, isolated from the legacy sync-token transport. */
    internal open val todoMutationGateway: TodoMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TodoMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(writeConvexConfig()),
                credentialSource = SecureConvexDeviceCredentialSource(storedConvexConfigSource),
            ),
        )
    }

    /** Capability-scoped Bitcoin bill-pay writes use the paired-device credential. */
    internal open val btcBillPayMutationGateway: BtcBillPayMutationGateway by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        BtcBillPayMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(writeConvexConfig()),
                credentialSource = SecureConvexDeviceCredentialSource(storedConvexConfigSource),
            ),
        )
    }

    /** Atomic adult-household Bitcoin-buy plus linked-income writes. */
    internal open val btcBuyIncomeMutationGateway: BtcBuyIncomeMutationGateway by lazy(
        LazyThreadSafetyMode.SYNCHRONIZED,
    ) {
        BtcBuyIncomeMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(writeConvexConfig()),
                credentialSource = SecureConvexDeviceCredentialSource(storedConvexConfigSource),
            ),
        )
    }

    /** Capability-scoped Bitcoin transfer writes. */
    internal open val btcTransferMutationGateway: BtcTransferMutationGateway by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        BtcTransferMutationGateway(
            ConvexDeviceMutationClient(
                configSource = MutableConvexConfigSource(writeConvexConfig()),
                credentialSource = SecureConvexDeviceCredentialSource(storedConvexConfigSource),
            ),
        )
    }

    /** Whether the capability-scoped todo device credential exists. */
    internal open fun hasTodoWriteCredential(): Boolean =
        synchronized(convexConfigLock) {
            storedConvexConfigSource.hasDeviceCredential()
        }

    /**
     * Stores a provisioned `<device id>.<device token>` pair. Provisioning is
     * intentionally separate from the legacy sync token used by other editors.
     */
    internal open fun saveTodoWriteCredential(value: String): Result<Unit> =
        synchronized(convexConfigLock) {
            runCatching {
                storedConvexConfigSource.updateDeviceCredential(ConvexDeviceCredential.parse(value.trim()))
                check(storedConvexConfigSource.hasDeviceCredential()) {
                    "the stored todo device credential could not be read back"
                }
            }
        }

    internal open fun removeTodoWriteCredential(): Result<Unit> =
        synchronized(convexConfigLock) {
            runCatching {
                storedConvexConfigSource.clearDeviceCredential()
                check(!storedConvexConfigSource.hasDeviceCredential()) {
                    "the removed todo device credential was still readable"
                }
            }
        }

    /** Whether a write credential exists. The value itself never reaches the UI. */
    internal open fun hasConvexWriteCredential(): Boolean =
        synchronized(convexConfigLock) {
            storedConvexConfigSource.hasSyncToken()
        }

    /**
     * Encrypts and stores a replacement write credential.
     *
     * The failure is returned rather than collapsed to false so a screen can say
     * which problem occurred: a blank entry, storage that refused the commit, or
     * a value that could not be read back after being written.
     */
    internal open fun saveConvexWriteCredential(token: String): Result<Unit> =
        synchronized(convexConfigLock) {
            runCatching {
                storedConvexConfigSource.updateSyncToken(token)
                check(storedConvexConfigSource.hasSyncToken()) {
                    "the stored write credential could not be read back"
                }
            }
        }

    /**
     * Removes the write credential through the same process lock and accessor
     * used by Save. Settings receives only the outcome and the postcondition;
     * the stored value never crosses this boundary.
     */
    internal open fun removeConvexWriteCredential(): Result<Unit> =
        synchronized(convexConfigLock) {
            runCatching {
                storedConvexConfigSource.clearSyncToken()
                check(!storedConvexConfigSource.hasSyncToken()) {
                    "the removed write credential was still readable"
                }
            }
        }

    val viewModelFactory: ViewModelProvider.Factory =
        object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(
                modelClass: Class<T>,
                extras: CreationExtras,
            ): T {
                require(modelClass == VaultViewModel::class.java) { "Unknown ViewModel: ${modelClass.name}" }
                @Suppress("UNCHECKED_CAST")
                return VaultViewModel(
                    rowSource = rowDataSource,
                    financeSource = RecoveringFinanceReadSource(
                        remoteForConfig = { config -> FinanceQueryRepositories.convex(config) },
                        configSource = convexConfigSource,
                        onUnauthorized = ::recoverRejectedConvexConfig,
                    ),
                    effectiveReadReady = effectiveReadReady,
                    enableRemote = ::enableRemoteRows,
                ) as T
            }
        }

    private fun enableRemoteRows(readToken: String) {
        val next =
            ConvexConfig(
                deploymentUrl = PRODUCTION_DEPLOYMENT,
                readToken = readToken,
                remoteReadEnabled = true,
            )
        synchronized(convexConfigLock) {
            storedConvexConfigSource.update(next)
            convexConfigSource.update(next)
        }
    }

    /**
     * Reset removes both grants created by combined bootstrap enrollment.
     * Clearing the device credential first prevents retained todo access if the
     * later read-config commit fails. Repeating reset on empty storage succeeds.
     */
    internal open fun removeStoredConvexCredential(): Boolean =
        synchronized(convexConfigLock) {
            resetStoredConvexBootstrap(
                stored = storedConvexConfigSource,
                effective = convexConfigSource,
            )
        }

    private fun recoverRejectedConvexConfig(rejected: ConvexConfig): Boolean =
        synchronized(convexConfigLock) {
            recoverRejectedStoredConvexConfig(
                rejected = rejected,
                stored = storedConvexConfigSource,
                effective = convexConfigSource,
            )
        }
}

// Public routing configuration, not a credential.
internal const val PRODUCTION_DEPLOYMENT = "https://keen-elephant-452.convex.cloud"

internal fun bundledReadBootstrapPair(): String =
    BuildConfig.CONVEX_READ_BOOTSTRAP_PAIR

/** Public build intent only; no credential or capability value enters UI state. */
internal fun bundledReadBootstrapRequestsTodoWrite(): Boolean =
    BuildConfig.CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE

internal fun initialConvexConfig(stored: ConvexConfig): ConvexConfig =
    stored.takeIf(ConvexConfig::allowsRemoteRead) ?: ConvexConfig()

/**
 * Stops a server-rejected stored credential from winning startup precedence.
 *
 * The compare-and-clear protects a newer manual entry from a late response to
 * an older request. A rejected active credential always leaves this process
 * disabled; there is no build-time credential to retry.
 */
internal fun recoverRejectedStoredConvexConfig(
    rejected: ConvexConfig,
    stored: SecureConvexConfigSource,
    effective: MutableConvexConfigSource,
): Boolean {
    val cleared =
        try {
            stored.clearIfCurrent(rejected)
        } catch (_: IOException) {
            // A failed synchronous SharedPreferences commit must not escape a
            // viewModelScope coroutine. The durable credential may need another
            // removal attempt after restart, but this process still fails
            // closed instead of retrying a rejected credential.
            if (effective.current().hasSameCredentialAs(rejected)) {
                effective.update(ConvexConfig())
            }
            return false
        }
    if (cleared) {
        if (effective.current().hasSameCredentialAs(rejected)) {
            effective.update(ConvexConfig())
        }
        return false
    }

    if (effective.current().hasSameCredentialAs(rejected)) {
        val currentStored = stored.current()
        effective.update(
            currentStored.takeIf {
                it.allowsRemoteRead && !it.hasSameCredentialAs(rejected)
            } ?: ConvexConfig(),
        )
    }
    return false
}

internal fun removeStoredConvexConfigIfPresent(
    stored: SecureConvexConfigSource,
    effective: MutableConvexConfigSource,
): Boolean {
    val currentStored = stored.current()
    if (!currentStored.allowsRemoteRead) return false

    stored.clear()
    if (effective.current().hasSameCredentialAs(currentStored)) {
        effective.update(ConvexConfig())
    }
    return true
}

internal fun resetStoredConvexBootstrap(
    stored: SecureConvexConfigSource,
    effective: MutableConvexConfigSource,
): Boolean =
    try {
        stored.clearDeviceCredential()
        check(!stored.hasDeviceCredential()) {
            "the reset todo device credential was still readable"
        }
        stored.clear()
        check(!stored.current().allowsRemoteRead) {
            "the reset read credential was still readable"
        }
        effective.update(ConvexConfig())
        true
    } catch (_: IOException) {
        false
    } catch (_: IllegalStateException) {
        false
    }

internal fun ConvexConfig.hasSameCredentialAs(other: ConvexConfig): Boolean =
    deploymentUrl == other.deploymentUrl &&
        readTokenOrNull() == other.readTokenOrNull() &&
        remoteReadEnabled == other.remoteReadEnabled

internal fun writeConvexConfig(): ConvexConfig =
    ConvexConfig(deploymentUrl = PRODUCTION_DEPLOYMENT)

/**
 * Adult and Mason source files already carry their canonical owner. Maddox has
 * no dedicated BTC-buy source, so his owner must be explicit or the row would be
 * silently tagged as adult household data.
 */
internal fun explicitBtcBuyOwner(member: FamilyMember): FamilyMember? =
    if (member == FamilyMember.MADDOX) member else null
