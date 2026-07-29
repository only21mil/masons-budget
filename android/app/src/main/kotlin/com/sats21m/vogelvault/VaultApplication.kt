package com.sats21m.vogelvault

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.SecureConvexSyncTokenSource
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.cache.VaultDatabase
import com.sats21m.vogelvault.ui.ConvexTransactionActions
import com.sats21m.vogelvault.ui.VaultViewModel
import java.io.IOException

/**
 * Process-scoped infrastructure and the ViewModel composition root.
 *
 * Dependencies remain lazy so a disabled/unconfigured build never opens a
 * Convex socket on startup.
 */
class VaultApplication : Application() {
    val database: VaultDatabase by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        VaultDatabase.create(this)
    }

    private val convexConfigLock = Any()

    private val storedConvexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }

    private val bakedConvexConfig: ConvexConfig by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        buildTimeConvexConfig(BuildConfig.CONVEX_READ_TOKEN)
    }

    /**
     * A valid manually entered credential wins across restarts. The baked debug
     * credential remains an in-memory seed for a fresh install or unusable
     * encrypted state; it is never copied into storage. A stored credential
     * keeps that precedence only until Convex rejects it.
     */
    val convexConfigSource: MutableConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        MutableConvexConfigSource(
            initial = initialConvexConfig(
                buildTime = bakedConvexConfig,
                stored = storedConvexConfigSource.current(),
            ),
        )
    }

    /**
     * Shared write transport. Every mutation reads the latest encrypted sync
     * token at request time; no write credential is baked into the app.
     */
    internal val convexMutationClient: ConvexMutationClient by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ConvexMutationClient(
            configSource = convexConfigSource,
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
     * Uses the closed mutation transport and remains fail-closed until an
     * approved encrypted sync-token source is provided. The read token is never
     * substituted and no write credential is bundled in the app.
     */
    internal val transactionActions by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        ConvexTransactionActions(ConvexMutationClient(convexConfigSource))
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
                    remoteInitiallyEnabled = convexConfigSource.current().allowsRemoteRead,
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

    internal fun hasStoredConvexCredential(): Boolean =
        synchronized(convexConfigLock) {
            storedConvexConfigSource.current().hasReadToken
        }

    /**
     * Settings removal shares the same process lock as Save and unauthorized
     * recovery. If recovery already cleared the manual credential and installed
     * a working baked fallback, a stale Settings button becomes a no-op instead
     * of disabling that fallback.
     */
    internal fun removeStoredConvexCredential(): Boolean =
        synchronized(convexConfigLock) {
            removeStoredConvexConfigIfPresent(
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
                fallback = bakedConvexConfig,
            )
        }
}

// Public routing configuration, not a credential.
internal const val PRODUCTION_DEPLOYMENT = "https://keen-elephant-452.convex.cloud"

internal fun initialConvexConfig(
    buildTime: ConvexConfig,
    stored: ConvexConfig,
): ConvexConfig =
    if (stored.allowsRemoteRead) {
        stored
    } else {
        buildTime
    }

/**
 * Stops a server-rejected stored credential from winning startup precedence.
 *
 * The compare-and-clear protects a newer manual entry from a late response to
 * an older request. A blank release-build fallback deliberately leaves remote
 * reads disabled after the rejected stored credential is removed.
 */
internal fun recoverRejectedStoredConvexConfig(
    rejected: ConvexConfig,
    stored: SecureConvexConfigSource,
    effective: MutableConvexConfigSource,
    fallback: ConvexConfig,
): Boolean {
    val cleared =
        try {
            stored.clearIfCurrent(rejected)
        } catch (_: IOException) {
            // A failed synchronous SharedPreferences commit must not escape a
            // viewModelScope coroutine. The durable credential may need another
            // removal attempt after restart, but this process can still fail
            // closed or install a distinct baked fallback safely.
            if (effective.current().hasSameCredentialAs(rejected)) {
                val next = fallbackAfterRejection(rejected, fallback)
                effective.update(next)
                return next.allowsRemoteRead
            }
            return false
        }
    if (cleared) {
        val next = fallbackAfterRejection(rejected, fallback)
        effective.update(next)
        return next.allowsRemoteRead
    }

    if (!stored.current().allowsRemoteRead && effective.current().hasSameCredentialAs(rejected)) {
        // The in-memory baked fallback was itself rejected. Disable it so the
        // next refresh cannot keep sending a credential known to be invalid.
        effective.update(ConvexConfig())
    }
    return false
}

internal fun removeStoredConvexConfigIfPresent(
    stored: SecureConvexConfigSource,
    effective: MutableConvexConfigSource,
): Boolean {
    val currentStored = stored.current()
    if (!currentStored.hasReadToken) return false

    stored.clear()
    if (effective.current().hasSameCredentialAs(currentStored)) {
        effective.update(ConvexConfig())
    }
    return true
}

private fun fallbackAfterRejection(
    rejected: ConvexConfig,
    fallback: ConvexConfig,
): ConvexConfig =
    if (fallback.hasSameCredentialAs(rejected)) {
        ConvexConfig()
    } else {
        fallback
    }

internal fun ConvexConfig.hasSameCredentialAs(other: ConvexConfig): Boolean =
    deploymentUrl == other.deploymentUrl &&
        readTokenOrNull() == other.readTokenOrNull() &&
        remoteReadEnabled == other.remoteReadEnabled

/**
 * Turns the debug BuildConfig field into a fail-closed runtime configuration.
 *
 * Blank (including whitespace-only) build input is deliberately indistinguishable
 * from the pre-injection build: remote reads remain disabled and fixtures render.
 */
internal fun buildTimeConvexConfig(readToken: String): ConvexConfig =
    ConvexConfig(
        deploymentUrl = PRODUCTION_DEPLOYMENT,
        readToken = readToken,
        remoteReadEnabled = readToken.isNotBlank(),
    )
