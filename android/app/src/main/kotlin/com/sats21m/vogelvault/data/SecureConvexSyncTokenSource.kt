package com.sats21m.vogelvault.data

import android.content.Context
import android.content.SharedPreferences
import java.io.IOException

/**
 * AndroidKeyStore-backed storage for the write credential.
 *
 * The sync token is deliberately isolated from the read configuration: clearing
 * a rejected read token cannot erase a valid write credential, and neither
 * credential is ever accepted as a fallback for the other.
 */
internal class SecureConvexSyncTokenSource private constructor(
    private val preferences: SharedPreferences,
    private val cipher: ConfigCipher,
) : ConvexSyncTokenSource {
    constructor(context: Context) : this(
        preferences =
            context.applicationContext.getSharedPreferences(
                PREFERENCES_NAME,
                Context.MODE_PRIVATE,
            ),
        cipher = AndroidKeyStoreConfigCipher(KEY_ALIAS),
    )

    private val lock = Any()

    override fun currentSyncToken(): String? =
        synchronized(lock) {
            val encoded = preferences.getString(KEY_SYNC_TOKEN, null) ?: return@synchronized null
            runCatching { cipher.decrypt(KEY_SYNC_TOKEN, encoded) }
                .getOrNull()
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
        }

    fun update(token: String) =
        synchronized(lock) {
            val normalized = token.trim()
            require(normalized.isNotEmpty()) { "sync token must not be blank" }
            val saved =
                preferences.edit()
                    .putString(KEY_SYNC_TOKEN, cipher.encrypt(KEY_SYNC_TOKEN, normalized))
                    .commit()
            if (!saved) throw IOException("encrypted Convex write credential was not persisted")
        }

    fun clear() =
        synchronized(lock) {
            if (!preferences.edit().remove(KEY_SYNC_TOKEN).commit()) {
                throw IOException("encrypted Convex write credential was not removed")
            }
        }

    val isConfigured: Boolean
        get() = currentSyncToken() != null

    private companion object {
        const val PREFERENCES_NAME = "convex_write_config_encrypted"
        const val KEY_ALIAS = "com.sats21m.vogelvault.convex-write-config.v1"
        const val KEY_SYNC_TOKEN = "sync_token"
    }
}
