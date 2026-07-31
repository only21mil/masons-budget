package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ReadBootstrapStatus

/** Non-secret, durable access state that screens may safely observe. */
internal enum class BootstrapAccess {
    NONE,
    READ_ONLY,
    READ_AND_TODO_WRITE,
}

/**
 * Redacted result of an enrollment attempt. Credential material must stay behind
 * [BootstrapEnrollment] and must never be added to this value.
 */
internal data class BootstrapConnectionResult(
    val status: ReadBootstrapStatus,
    val access: BootstrapAccess,
)

/**
 * Small boundary between Compose and capability-aware application storage.
 * Implementations report durable grants established by enrollment, not merely
 * the presence of a device credential.
 */
internal interface BootstrapEnrollment {
    fun isBundledEnrollmentAvailable(): Boolean

    fun currentAccess(): BootstrapAccess

    suspend fun connect(): BootstrapConnectionResult

    /** Returns the remaining access, or null when storage refused the reset. */
    fun reset(): BootstrapAccess?
}

/** Compatibility adapter for the legacy read-only bootstrap. */
internal class ReadOnlyBootstrapEnrollment(
    private val application: VaultApplication,
) : BootstrapEnrollment {
    override fun isBundledEnrollmentAvailable(): Boolean =
        application.hasBundledReadBootstrap()

    override fun currentAccess(): BootstrapAccess =
        if (application.hasStoredConvexCredential()) {
            BootstrapAccess.READ_ONLY
        } else {
            BootstrapAccess.NONE
        }

    override suspend fun connect(): BootstrapConnectionResult {
        val status = application.connectBundledReadBootstrap()
        return BootstrapConnectionResult(status = status, access = currentAccess())
    }

    override fun reset(): BootstrapAccess? {
        if (!application.removeStoredConvexCredential()) return null
        return currentAccess().takeIf { it == BootstrapAccess.NONE }
    }
}
