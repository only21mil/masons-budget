package com.sats21m.vogelvault.data

import android.content.Context
import android.content.SharedPreferences
import java.io.IOException

/**
 * Runtime-only storage for the shared Convex sync credential.
 *
 * The token is encrypted with an AndroidKeyStore key and lives in a preference
 * file separate from read configuration, so clearing a rejected read token
 * cannot silently disable writes (or vice versa).
 */
internal class SecureConvexSyncTokenSource(
    private val preferences: SharedPreferences,
    private val cipher: ConfigCipher,
) : ConvexSyncTokenSource {
    constructor(context: Context) : this(
        preferences = context.applicationContext.getSharedPreferences(
            PREFERENCES_NAME,
            Context.MODE_PRIVATE,
        ),
        cipher = AndroidKeyStoreConfigCipher(KEY_ALIAS),
    )

    private val lock = Any()

    override fun currentSyncToken(): String? =
        synchronized(lock) {
            preferences.getString(KEY_SYNC_TOKEN, null)
                ?.let { encoded -> runCatching { cipher.decrypt(KEY_SYNC_TOKEN, encoded) }.getOrNull() }
                ?.trim()
                ?.takeIf(String::isNotEmpty)
        }

    fun update(token: String) =
        synchronized(lock) {
            val trimmed = token.trim()
            require(trimmed.isNotEmpty()) { "sync token must not be blank" }
            val encoded = cipher.encrypt(KEY_SYNC_TOKEN, trimmed)
            if (!preferences.edit().putString(KEY_SYNC_TOKEN, encoded).commit()) {
                throw IOException("encrypted Convex sync token was not persisted")
            }
        }

    fun clear() =
        synchronized(lock) {
            if (!preferences.edit().remove(KEY_SYNC_TOKEN).commit()) {
                throw IOException("encrypted Convex sync token was not removed")
            }
        }

    private companion object {
        const val PREFERENCES_NAME = "convex_sync_token_encrypted"
        const val KEY_SYNC_TOKEN = "sync_token"
        const val KEY_ALIAS = "com.sats21m.vogelvault.convex-sync-token.v1"
    }
}
