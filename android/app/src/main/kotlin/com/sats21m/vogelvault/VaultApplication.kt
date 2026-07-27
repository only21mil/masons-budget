package com.sats21m.vogelvault

import android.app.Application
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.RowReadModelLoader
import com.sats21m.vogelvault.data.cache.VaultDatabase

/**
 * Process-scoped infrastructure only.
 *
 * Dependencies remain lazy so a disabled/unconfigured build never opens a
 * Convex socket on startup.
 */
class VaultApplication : Application() {
    val database: VaultDatabase by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        VaultDatabase.create(this)
    }

    val convexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }

    fun rowReadModelLoader(): RowReadModelLoader =
        RowReadModelLoader(RowQueryRepositories.convex(convexConfigSource))

    fun enableRemoteRows(readToken: String) {
        convexConfigSource.update(
            ConvexConfig(
                deploymentUrl = PRODUCTION_DEPLOYMENT,
                readToken = readToken,
                remoteReadEnabled = true,
            ),
        )
    }

    private companion object {
        // Public routing configuration, not a credential.
        const val PRODUCTION_DEPLOYMENT = "https://keen-elephant-452.convex.cloud"
    }
}
