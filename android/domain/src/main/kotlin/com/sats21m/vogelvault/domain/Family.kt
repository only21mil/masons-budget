package com.sats21m.vogelvault.domain

/**
 * The Vogel Vault — shared family/visibility contract, Kotlin mirror.
 *
 * This is a direct port of `MasonsBudget/MasonsBudget/Models/SharedEnums.swift`,
 * which stays the source of truth for all three clients. Parity with Swift and
 * TypeScript is enforced by `shared/domain/fixtures/visibility-cases.json`,
 * which this module's test suite and the TypeScript suite both load.
 *
 * HARD RULE (repo AGENTS.md): Victor and Rachel are ONE shared household and see
 * identical data. Canonical adult records default to owner "victor", so any strict
 * `owner == activeMember` check empties Rachel's tabs. That bug shipped in v0.3.
 * Always route visibility through [canSee] — never strict equality.
 */
enum class FamilyMember(val key: String) {
    VICTOR("victor"),
    RACHEL("rachel"),
    MASON("mason"),
    MADDOX("maddox");

    val isAdult: Boolean
        get() = this == VICTOR || this == RACHEL

    /** Canonical owner for financial records; the active profile remains the actor/viewer. */
    val ledgerOwner: FamilyMember
        get() = if (isAdult) VICTOR else this

    /** Adults get the full budget surface; kids get a Bitcoin-focused one. */
    val showsFullBudget: Boolean
        get() = isAdult

    val displayName: String
        get() = key.replaceFirstChar { it.uppercase() }

    val profileDescription: String
        get() = when (this) {
            VICTOR, RACHEL -> "Full budget, spending & Bitcoin"
            MASON -> "Bitcoin stack & spending"
            MADDOX -> "Bitcoin stack & allowance"
        }

    /** Kids cannot switch out of their own profile. */
    val allowedSwitchTargets: List<FamilyMember>
        get() = if (isAdult) entries.toList() else listOf(this)

    /** Eligible destinations behind the Android profile authentication gate. */
    val gatedSwitchTargets: List<FamilyMember>
        get() = if (isAdult) allowedSwitchTargets else entries.filter { it == this || it.isAdult }

    /** Every profile switch is authenticated in the shared baseline contract. */
    val requiresAuthToSwitch: Boolean
        get() = true

    val transactionsDataFileName: String
        get() = when (this) {
            VICTOR, RACHEL -> "transactions"
            MASON -> "mason-transactions"
            MADDOX -> "maddox-transactions"
        }

    val btcBuysDataFileName: String
        get() = if (this == MASON) "mason-bitcoin-buys" else "bitcoin-buys"

    val hasDedicatedChildFinanceFiles: Boolean
        get() = this == MASON

    /** Adults can see the household and the kids. Kids see only their own data. */
    fun canSee(dataOwnedBy: FamilyMember): Boolean {
        if (this == dataOwnedBy) return true
        if (isAdult) return true
        return false
    }

    /**
     * Net-worth totals are household-scoped for adults, but child stacks must
     * never roll into adult totals.
     *
     * Deliberately narrower than [canSee]: an adult can see Mason's balance on
     * his profile, but it is not part of adult net worth.
     */
    fun sharesNetWorth(with: FamilyMember): Boolean {
        if (this == with) return true
        return isAdult && with.isAdult
    }

    companion object {
        /** Untagged adult records resolve to "victor". Mirrors the Swift default. */
        val DEFAULT_OWNER: FamilyMember = VICTOR

        fun fromKeyOrNull(key: String?): FamilyMember? = entries.firstOrNull { it.key == key }

        /** Unknown or absent owners fall back to the canonical default rather than throwing. */
        fun coerceOwner(key: String?): FamilyMember = fromKeyOrNull(key) ?: DEFAULT_OWNER
    }
}

/** Anything the visibility rules can be applied to. */
interface Owned {
    val owner: FamilyMember
}

/**
 * Filter to what [viewer] may see. Clients should use this rather than
 * hand-rolling a predicate per screen, so the v0.3 strict-equality regression
 * cannot reappear one view at a time.
 */
fun <T : Owned> List<T>.visibleTo(viewer: FamilyMember): List<T> =
    filter { viewer.canSee(it.owner) }

/** Filter to what counts toward [viewer]'s net worth. Narrower than [visibleTo]. */
fun <T : Owned> List<T>.netWorthScopeFor(viewer: FamilyMember): List<T> =
    filter { viewer.sharesNetWorth(it.owner) }
