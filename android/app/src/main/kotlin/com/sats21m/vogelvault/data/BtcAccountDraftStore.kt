package com.sats21m.vogelvault.data

import android.content.SharedPreferences
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** The request and its read revision stay together across dismissal and process recreation. */
@Serializable
internal data class PendingBtcAccount(
    val key: String,
    val ownerKey: String,
    val label: String,
    val custodyKey: String,
    val asOf: String,
    val baseUpdatedAtMs: Long?,
) {
    fun mutation(): ConvexMutation.UpsertBtcAccountFromDevice = ConvexMutation.UpsertBtcAccountFromDevice(
        BtcAccountInput(key, FamilyMember.entries.first { it.key == ownerKey }, label,
            Custody.entries.first { it.key == custodyKey }, 0L, 0L, asOf),
        baseUpdatedAtMs,
    )
}

internal class BtcAccountDraftStore(private val preferences: SharedPreferences? = null) {
    private val pending = mutableMapOf<String, PendingBtcAccount>()

    @Synchronized
    fun current(viewer: FamilyMember): PendingBtcAccount? {
        val scope = viewer.ledgerOwner.key
        return pending[scope] ?: preferences?.getString(scope, null)?.let { encoded ->
            Json.decodeFromString<PendingBtcAccount>(encoded).also {
                check(it.ownerKey == scope && viewer.isAdult)
                it.mutation() // Refuse corrupt persisted requests before offering a retry.
                pending[scope] = it
            }
        }
    }

    @Synchronized
    fun stage(viewer: FamilyMember, draft: PendingBtcAccount): PendingBtcAccount {
        check(viewer.isAdult && draft.ownerKey == viewer.ledgerOwner.key)
        current(viewer)?.let { return it }
        draft.mutation()
        check(preferences?.edit()?.putString(draft.ownerKey, Json.encodeToString(draft))?.commit() != false) {
            "Account draft could not be saved on this phone."
        }
        pending[draft.ownerKey] = draft
        return draft
    }

    @Synchronized
    fun release(viewer: FamilyMember, draft: PendingBtcAccount): Boolean {
        if (current(viewer) != draft) return true
        val removed = preferences?.edit()?.remove(draft.ownerKey)?.commit() ?: true
        if (removed) pending.remove(draft.ownerKey)
        return removed
    }
}
