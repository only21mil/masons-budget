package com.sats21m.vogelvault

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import com.sats21m.vogelvault.data.ConvexConfig
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

    val convexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
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
