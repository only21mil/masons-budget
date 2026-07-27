package com.sats21m.vogelvault

import android.app.Application
import com.sats21m.vogelvault.data.SecureConvexConfigSource
import com.sats21m.vogelvault.data.cache.VaultDatabase

/**
 * Process-scoped infrastructure only.
 *
 * Nothing in MainActivity or VaultViewModel is wired to these dependencies yet;
 * both are lazy so adding the Application class changes no read path on startup.
 */
class VaultApplication : Application() {
    val database: VaultDatabase by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        VaultDatabase.create(this)
    }

    val convexConfigSource: SecureConvexConfigSource by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        SecureConvexConfigSource(this)
    }
}
