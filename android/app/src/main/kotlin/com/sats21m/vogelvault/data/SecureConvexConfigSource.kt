package com.sats21m.vogelvault.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.sats21m.vogelvault.domain.FamilyMember
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Atomic persistence boundary used by one-time bootstrap enrollment. */
internal interface ConvexBootstrapCredentialStore {
    /**
     * Atomically replaces read configuration and, when supplied, the paired-device credential.
     *
     * A null [deviceCredential] is a read-only enrollment: an existing valid device credential
     * is preserved. The returned value is a durable readback, not the caller's input.
     */
    fun commitBootstrap(
        readConfig: ConvexConfig,
        deviceCredential: ConvexDeviceCredential? = null,
    ): StoredConvexBootstrap
}

/** Durable bootstrap state with a deliberately redacted string representation. */
internal class StoredConvexBootstrap(
    val readConfig: ConvexConfig,
    val deviceCredential: ConvexDeviceCredential?,
) {
    override fun toString(): String =
        "StoredConvexBootstrap(read=${readConfig.readiness}, " +
            "deviceCredential=${if (deviceCredential == null) "absent" else "present"})"
}

/**
 * Durable Convex configuration encrypted with an AndroidKeyStore AES/GCM key.
 *
 * Secrets live in private SharedPreferences only as authenticated ciphertext and
 * never enter Room. Each field uses a fresh 96-bit IV and its preference key as
 * additional authenticated data, so ciphertext cannot be swapped between fields.
 * Any missing/corrupt/invalidated value fails closed to disabled configuration.
 */
internal class SecureConvexConfigSource internal constructor(
    private val preferences: SharedPreferences,
    private val cipher: ConfigCipher,
) : ConvexConfigSource,
    ConvexBootstrapCredentialStore {
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
            readConfigLocked()
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

    override fun commitBootstrap(
        readConfig: ConvexConfig,
        deviceCredential: ConvexDeviceCredential?,
    ): StoredConvexBootstrap =
        synchronized(lock) {
            val preservedDeviceCredential = deviceCredential ?: readDeviceCredentialLocked()
            val editor = preferences.edit()
            putOrRemove(editor, KEY_DEPLOYMENT_URL, readConfig.deploymentUrl)
            putOrRemove(editor, KEY_READ_TOKEN, readConfig.readTokenOrNull())
            putOrRemove(editor, KEY_REMOTE_READ_ENABLED, readConfig.remoteReadEnabled.toString())
            if (deviceCredential != null) {
                val profile = requireNotNull(deviceCredential.profile) {
                    "device credential must include its server-bound profile"
                }
                putOrRemove(editor, KEY_DEVICE_ID, deviceCredential.deviceId)
                putOrRemove(editor, KEY_DEVICE_TOKEN, deviceCredential.deviceToken)
                putOrRemove(editor, KEY_DEVICE_PROFILE, profile.key)
            } else if (preservedDeviceCredential == null) {
                // Do not carry a partial or unauthenticated old pair into a new enrollment.
                editor.remove(KEY_DEVICE_ID)
                editor.remove(KEY_DEVICE_TOKEN)
                editor.remove(KEY_DEVICE_PROFILE)
            }
            if (!editor.commit()) throw IOException("encrypted Convex bootstrap was not persisted")

            val durable = readBootstrapLocked()
            if (
                !durable.readConfig.hasSameCredentialAs(readConfig) ||
                durable.deviceCredential != preservedDeviceCredential
            ) {
                throw IOException("encrypted Convex bootstrap failed durable readback")
            }
            durable
        }

    internal fun currentBootstrap(): StoredConvexBootstrap =
        synchronized(lock) {
            readBootstrapLocked()
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

    internal fun hasDeviceCredential(): Boolean =
        synchronized(lock) {
            readDeviceCredentialLocked() != null
        }

    /** Atomically store the backend-bound credential required by safe row mutations. */
    internal fun updateDeviceCredential(credential: ConvexDeviceCredential) =
        synchronized(lock) {
            val profile = requireNotNull(credential.profile) {
                "device credential must include its server-bound profile"
            }
            val editor = preferences.edit()
            putOrRemove(editor, KEY_DEVICE_ID, credential.deviceId)
            putOrRemove(editor, KEY_DEVICE_TOKEN, credential.deviceToken)
            putOrRemove(editor, KEY_DEVICE_PROFILE, profile.key)
            if (!editor.commit()) throw IOException("encrypted Convex device credential was not persisted")
        }

    internal fun clearDeviceCredential() =
        synchronized(lock) {
            val editor = preferences.edit()
            editor.remove(KEY_DEVICE_ID)
            editor.remove(KEY_DEVICE_TOKEN)
            editor.remove(KEY_DEVICE_PROFILE)
            if (!editor.commit()) throw IOException("encrypted Convex device credential was not cleared")
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

    private fun readConfigLocked(): ConvexConfig {
        if (!preferences.contains(KEY_REMOTE_READ_ENABLED)) return ConvexConfig()

        return runCatching {
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

    private fun readBootstrapLocked(): StoredConvexBootstrap =
        StoredConvexBootstrap(
            readConfig = readConfigLocked(),
            deviceCredential = readDeviceCredentialLocked(),
        )

    internal fun currentSyncToken(): String? =
        synchronized(lock) {
            readSyncTokenLocked()
        }

    internal fun currentDeviceCredential(): ConvexDeviceCredential? =
        synchronized(lock) {
            readDeviceCredentialLocked()
        }

    private fun readSyncTokenLocked(): String? =
        runCatching {
            read(KEY_SYNC_TOKEN)?.trim()?.takeIf { it.isNotEmpty() }
        }.getOrNull()

    private fun readDeviceCredentialLocked(): ConvexDeviceCredential? =
        runCatching {
            val deviceId = read(KEY_DEVICE_ID)?.trim()?.takeIf { it.isNotEmpty() } ?: return@runCatching null
            val deviceToken = read(KEY_DEVICE_TOKEN)?.trim()?.takeIf { it.isNotEmpty() } ?: return@runCatching null
            val profile = FamilyMember.fromKeyOrNull(read(KEY_DEVICE_PROFILE)) ?: return@runCatching null
            ConvexDeviceCredential(deviceId, deviceToken, profile)
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
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_TOKEN = "device_token"
        const val KEY_DEVICE_PROFILE = "device_profile"
    }
}

internal class SecureConvexDeviceCredentialSource(
    private val stored: SecureConvexConfigSource,
) : ConvexDeviceCredentialSource {
    override fun currentDeviceCredential(): ConvexDeviceCredential? = stored.currentDeviceCredential()
}

/**
 * Admin mutation credential source backed by AndroidKeyStore encryption.
 *
 * Keeping this adapter internal prevents UI and logging code from gaining
 * access to the credential while still allowing [ConvexMutationClient] to read
 * the latest saved value for every request. Interactive task writes must use
 * [SecureConvexDeviceCredentialSource], never this shared sync-token source.
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

private class AndroidKeyStoreConfigCipher(
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
