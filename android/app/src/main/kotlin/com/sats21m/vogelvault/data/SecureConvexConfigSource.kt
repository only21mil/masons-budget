package com.sats21m.vogelvault.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Durable Convex configuration encrypted with an AndroidKeyStore AES/GCM key.
 *
 * Secrets live in private SharedPreferences only as authenticated ciphertext and
 * never enter Room. Each field uses a fresh 96-bit IV and its preference key as
 * additional authenticated data, so ciphertext cannot be swapped between fields.
 * Any missing/corrupt/invalidated value fails closed to disabled configuration.
 */
class SecureConvexConfigSource internal constructor(
    private val preferences: SharedPreferences,
    private val cipher: ConfigCipher,
) : ConvexConfigSource {
    constructor(context: Context) : this(
        preferences =
            context.applicationContext.getSharedPreferences(
                PREFERENCES_NAME,
                Context.MODE_PRIVATE,
            ),
        cipher = AndroidKeyStoreConfigCipher(KEY_ALIAS),
    )

    private val lock = Any()

    override fun current(): ConvexConfig =
        synchronized(lock) {
            if (!preferences.contains(KEY_REMOTE_READ_ENABLED)) return@synchronized ConvexConfig()

            runCatching {
                ConvexConfig(
                    deploymentUrl = read(KEY_DEPLOYMENT_URL),
                    readToken = read(KEY_READ_TOKEN),
                    remoteReadEnabled =
                        read(KEY_REMOTE_READ_ENABLED)?.toBooleanStrictOrNull()
                            ?: throw GeneralSecurityException("invalid encrypted boolean"),
                )
            }.getOrElse {
                // Keystore invalidation, tampering and partial writes all have the same
                // safe answer: remote reads remain off and no secret is exposed.
                ConvexConfig()
            }
        }

    /** Encrypt and atomically persist a complete configuration replacement. */
    fun update(next: ConvexConfig) =
        synchronized(lock) {
            val editor = preferences.edit()
            putOrRemove(editor, KEY_DEPLOYMENT_URL, next.deploymentUrl)
            putOrRemove(editor, KEY_READ_TOKEN, next.readTokenOrNull())
            putOrRemove(editor, KEY_REMOTE_READ_ENABLED, next.remoteReadEnabled.toString())
            if (!editor.commit()) throw IOException("encrypted Convex configuration was not persisted")
        }

    /**
     * Returns only whether a write credential is available.
     *
     * UI code must never receive the token value. The dedicated
     * [SecureConvexSyncTokenSource] is the only production reader.
     */
    fun hasSyncToken(): Boolean =
        synchronized(lock) {
            readSyncTokenLocked() != null
        }

    /** Encrypt and persist a replacement write credential. */
    fun updateSyncToken(syncToken: String) =
        synchronized(lock) {
            val normalized = syncToken.trim().takeIf { it.isNotEmpty() }
                ?: throw IllegalArgumentException("sync token must not be blank")
            val editor = preferences.edit()
            putOrRemove(editor, KEY_SYNC_TOKEN, normalized)
            if (!editor.commit()) throw IOException("encrypted Convex sync token was not persisted")
        }

    /** Remove only the write credential, leaving row-read configuration intact. */
    fun clearSyncToken() =
        synchronized(lock) {
            val editor = preferences.edit()
            editor.remove(KEY_SYNC_TOKEN)
            if (!editor.commit()) throw IOException("encrypted Convex sync token was not cleared")
        }

    fun clear() =
        synchronized(lock) {
            clearReadConfigurationLocked()
        }

    /**
     * Clears only the complete credential that produced a rejected request.
     *
     * A user can replace the token while an older request is in flight. Exact
     * comparison keeps that newer credential from being erased by the late
     * unauthorized response.
     */
    fun clearIfCurrent(expected: ConvexConfig): Boolean =
        synchronized(lock) {
            if (!expected.allowsRemoteRead || !current().hasSameCredentialAs(expected)) {
                return@synchronized false
            }
            clearReadConfigurationLocked()
            true
        }

    private fun read(key: String): String? = preferences.getString(key, null)?.let { cipher.decrypt(key, it) }

    internal fun currentSyncToken(): String? =
        synchronized(lock) {
            readSyncTokenLocked()
        }

    private fun readSyncTokenLocked(): String? =
        runCatching {
            read(KEY_SYNC_TOKEN)?.trim()?.takeIf { it.isNotEmpty() }
        }.getOrNull()

    private fun clearReadConfigurationLocked() {
        val editor = preferences.edit()
        editor.remove(KEY_DEPLOYMENT_URL)
        editor.remove(KEY_READ_TOKEN)
        editor.remove(KEY_REMOTE_READ_ENABLED)
        if (!editor.commit()) {
            throw IOException("encrypted Convex configuration was not cleared")
        }
    }

    private fun ConvexConfig.hasSameCredentialAs(other: ConvexConfig): Boolean =
        deploymentUrl == other.deploymentUrl &&
            readTokenOrNull() == other.readTokenOrNull() &&
            remoteReadEnabled == other.remoteReadEnabled

    private fun putOrRemove(
        editor: SharedPreferences.Editor,
        key: String,
        value: String?,
    ) {
        if (value == null) {
            editor.remove(key)
        } else {
            editor.putString(key, cipher.encrypt(key, value))
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "convex_config_encrypted"
        const val KEY_ALIAS = "com.sats21m.vogelvault.convex-config.v1"
        const val KEY_DEPLOYMENT_URL = "deployment_url"
        const val KEY_READ_TOKEN = "read_token"
        const val KEY_REMOTE_READ_ENABLED = "remote_read_enabled"
        const val KEY_SYNC_TOKEN = "sync_token"
    }
}

/**
 * Production mutation credential source backed by AndroidKeyStore encryption.
 *
 * Keeping this adapter internal prevents UI and logging code from gaining
 * access to the credential while still allowing [ConvexMutationClient] to read
 * the latest saved value for every request.
 */
internal class SecureConvexSyncTokenSource(
    private val stored: SecureConvexConfigSource,
) : ConvexSyncTokenSource {
    override fun currentSyncToken(): String? = stored.currentSyncToken()
}

internal interface ConfigCipher {
    fun encrypt(
        field: String,
        plaintext: String,
    ): String

    fun decrypt(
        field: String,
        encoded: String,
    ): String
}

internal class AndroidKeyStoreConfigCipher(
    private val alias: String,
) : ConfigCipher {
    override fun encrypt(
        field: String,
        plaintext: String,
    ): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(field.toByteArray(StandardCharsets.UTF_8))
        val encrypted = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "AndroidKeyStore returned an unexpected GCM IV" }

        val payload =
            ByteBuffer
                .allocate(1 + IV_BYTES + encrypted.size)
                .put(FORMAT_VERSION)
                .put(iv)
                .put(encrypted)
                .array()
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    override fun decrypt(
        field: String,
        encoded: String,
    ): String {
        val payload =
            try {
                Base64.decode(encoded, Base64.NO_WRAP)
            } catch (error: IllegalArgumentException) {
                throw GeneralSecurityException("invalid encrypted config encoding", error)
            }
        if (payload.size <= 1 + IV_BYTES + GCM_TAG_BYTES) {
            throw GeneralSecurityException("encrypted config payload is truncated")
        }
        val buffer = ByteBuffer.wrap(payload)
        if (buffer.get() != FORMAT_VERSION) {
            throw GeneralSecurityException("unsupported encrypted config format")
        }
        val iv = ByteArray(IV_BYTES).also { buffer.get(it) }
        val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(field.toByteArray(StandardCharsets.UTF_8))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        generator.init(
            KeyGenParameterSpec
                .Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val GCM_TAG_BITS = 128
        const val GCM_TAG_BYTES = GCM_TAG_BITS / 8
        const val FORMAT_VERSION: Byte = 1
    }
}
