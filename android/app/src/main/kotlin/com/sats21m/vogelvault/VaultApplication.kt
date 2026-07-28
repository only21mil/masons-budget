package com.sats21m.vogelvault

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.cache.VaultDatabase
import com.sats21m.vogelvault.ui.VaultViewModel

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

    private val storedConvexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }

    /**
     * A valid manually entered credential wins across restarts. The baked debug
     * credential remains an in-memory seed for a fresh install or unusable
     * encrypted state; it is never copied into storage.
     */
    val convexConfigSource: MutableConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        val buildTime = buildTimeConvexConfig(BuildConfig.CONVEX_READ_TOKEN)
        MutableConvexConfigSource(
            initial = initialConvexConfig(
                buildTime = buildTime,
                stored = storedConvexConfigSource.current(),
            ),
        )
    }

    private val rowDataSource: CachedRowDataSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        CachedRowDataSource(
            remote = RowQueryRepositories.convex(convexConfigSource),
            dao = database.cacheDao(),
        )
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
        storedConvexConfigSource.update(next)
        convexConfigSource.update(next)
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
