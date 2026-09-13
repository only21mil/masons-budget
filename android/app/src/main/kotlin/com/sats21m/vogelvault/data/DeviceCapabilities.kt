package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.FamilyMember

internal enum class DeviceCapability(val wire: String, val action: String) {
    TODOS("todos:write", "tasks"),
    TRANSACTIONS("transactions:write", "transactions"),
    BUDGET("budget:write", "the budget"),
    BITCOIN("bitcoin:write", "Bitcoin records"),
}

/** Non-secret snapshot of the grants returned by pairing. */
internal data class DeviceCapabilities(
    val profile: FamilyMember? = null,
    val granted: Set<String> = emptySet(),
) {
    fun allows(profile: FamilyMember, capability: DeviceCapability): Boolean =
        this.profile == profile && capability.wire in granted

    fun unavailableReason(profile: FamilyMember, capability: DeviceCapability): String? = when {
        this.profile == null -> "Connect this phone before changing ${capability.action}."
        this.profile != profile -> "Connect this phone for ${profile.displayName} to make changes."
        capability.wire !in granted -> "This phone has read-only access to ${capability.action}."
        else -> null
    }

    companion object {
        val supported = DeviceCapability.entries.map { it.wire }.toSet()
        val legacy = setOf(DeviceCapability.TODOS.wire)
    }
}
