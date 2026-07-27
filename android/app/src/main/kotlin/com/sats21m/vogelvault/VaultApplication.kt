package com.sats21m.vogelvault

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import com.sats21m.vogelvault.data.RowQueryRepositories
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.cache.CachedRowDataSource
import com.sats21m.vogelvault.data.cache.VaultDatabase
import com.sats21m.vogelvault.ui.VaultViewModel

/**
 * Process-scoped infrastructure and the ViewModel composition root.
 */
class VaultApplication : Application() {
    val database: VaultDatabase by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        VaultDatabase.create(this)
    }

    val convexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }

    val viewModelFactory: ViewModelProvider.Factory =
        object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(
                modelClass: Class<T>,
                extras: CreationExtras,
            ): T {
                require(modelClass == VaultViewModel::class.java) { "Unknown ViewModel: ${modelClass.name}" }
                val source =
                    if (convexConfigSource.current().remoteReadEnabled) {
                        CachedRowDataSource(
                            remote = RowQueryRepositories.convex(convexConfigSource),
                            dao = database.cacheDao(),
                        )
                    } else {
                        null
                    }
                @Suppress("UNCHECKED_CAST")
                return VaultViewModel(source) as T
            }
        }
}
