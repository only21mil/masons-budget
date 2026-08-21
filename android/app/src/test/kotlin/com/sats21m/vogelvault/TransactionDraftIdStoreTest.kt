package com.sats21m.vogelvault

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.BtcBuyWriteSurface
import com.sats21m.vogelvault.ui.btcBuyDraftIdScope
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TransactionDraftIdStoreTest {
    private lateinit var preferences: SharedPreferences

    @BeforeTest
    fun setUp() {
        val context: Application = RuntimeEnvironment.getApplication()
        preferences =
            context.getSharedPreferences(
                "draft-id-test-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
    }

    @Test
    fun `persisted pending ids survive store recreation per scope`() {
        val original = TransactionDraftIdStore(preferences)
        val adultId = original.currentId(ADULT_SCOPE)
        val masonId = original.currentId(MASON_SCOPE)

        val restored = TransactionDraftIdStore(preferences)

        assertEquals(adultId, restored.currentId(ADULT_SCOPE))
        assertEquals(masonId, restored.currentId(MASON_SCOPE))
        assertNotEquals(adultId, masonId)
    }

    @Test
    fun `legacy fallback is read only across every bitcoin buy surface and family member`() {
        val legacyId = "android-legacy-adult"

        BtcBuyWriteSurface.entries.forEach { surface ->
            FamilyMember.entries.forEach { profile ->
                val scope = btcBuyDraftIdScope(surface, profile)
                assertEquals(
                    true,
                    preferences.edit()
                        .clear()
                        .putString(LEGACY_ADULT_KEY, legacyId)
                        .commit(),
                )
                val beforeRead = preferences.all
                val store = TransactionDraftIdStore(preferences)

                val pendingId = store.currentId(scope)

                if (profile.ledgerOwner == FamilyMember.VICTOR) {
                    assertEquals(legacyId, pendingId, "$surface/${profile.key}")
                    assertEquals(beforeRead, preferences.all, "$surface/${profile.key}")
                } else {
                    assertNotEquals(legacyId, pendingId, "$surface/${profile.key}")
                    assertEquals(legacyId, preferences.getString(LEGACY_ADULT_KEY, null), "$surface/${profile.key}")
                    assertEquals(pendingId, preferences.getString(scope, null), "$surface/${profile.key}")
                }
            }
        }
    }

    @Test
    fun `adult acceptance clears the read only legacy fallback`() {
        val legacyId = "android-legacy-adult"
        assertEquals(true, preferences.edit().putString(LEGACY_ADULT_KEY, legacyId).commit())
        val store = TransactionDraftIdStore(preferences)

        assertEquals(legacyId, store.currentId(ADULT_SCOPE))
        store.rotateAfterAcceptance(ADULT_SCOPE, legacyId)

        assertNull(preferences.getString(LEGACY_ADULT_KEY, null))
        assertNull(preferences.getString(ADULT_SCOPE, null))
    }

    @Test
    fun `adult scoped acceptance also clears a stale legacy fallback`() {
        val legacyId = "android-legacy-adult"
        val scopedId = "android-scoped-adult"
        assertEquals(
            true,
            preferences.edit()
                .putString(LEGACY_ADULT_KEY, legacyId)
                .putString(ADULT_SCOPE, scopedId)
                .commit(),
        )
        val store = TransactionDraftIdStore(preferences)

        store.rotateAfterAcceptance(ADULT_SCOPE, scopedId)

        assertNull(preferences.getString(LEGACY_ADULT_KEY, null))
        assertNull(preferences.getString(ADULT_SCOPE, null))
    }

    @Test
    fun `non adult acceptance cannot clear the adult legacy fallback`() {
        val legacyId = "android-legacy-adult"
        assertEquals(true, preferences.edit().putString(LEGACY_ADULT_KEY, legacyId).commit())
        val store = TransactionDraftIdStore(preferences)
        val maddoxId = store.currentId(MADDOX_SCOPE)

        store.rotateAfterAcceptance(MADDOX_SCOPE, maddoxId)

        assertEquals(legacyId, preferences.getString(LEGACY_ADULT_KEY, null))
        assertNull(preferences.getString(MADDOX_SCOPE, null))
    }

    @Test
    fun `new pending ids are synchronously committed before return`() {
        val context: Application = RuntimeEnvironment.getApplication()
        val delegate =
            context.getSharedPreferences(
                "draft-id-commit-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
        val tracked = CommitTrackingPreferences(delegate)
        val store = TransactionDraftIdStore(tracked)

        val id = store.currentId(ADULT_SCOPE)

        assertEquals(1, tracked.commitCalls)
        assertEquals(id, delegate.getString(ADULT_SCOPE, null))
    }

    @Test
    fun `failed pending id commit refuses an unpersisted id`() {
        val context: Application = RuntimeEnvironment.getApplication()
        val delegate =
            context.getSharedPreferences(
                "draft-id-commit-failure-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
        val tracked = CommitTrackingPreferences(delegate, commitResult = false)
        val store = TransactionDraftIdStore(tracked)

        assertFailsWith<IllegalStateException> {
            store.currentId(ADULT_SCOPE)
        }

        assertEquals(1, tracked.commitCalls)
        assertNull(delegate.getString(ADULT_SCOPE, null))
    }

    @Test
    fun `failed acceptance clear keeps the lease available for retry`() {
        val context: Application = RuntimeEnvironment.getApplication()
        val delegate =
            context.getSharedPreferences(
                "draft-id-clear-failure-${UUID.randomUUID()}",
                Context.MODE_PRIVATE,
            )
        val persistedId = "android-persisted-${UUID.randomUUID()}"
        assertEquals(true, delegate.edit().putString(ADULT_SCOPE, persistedId).commit())
        val tracked = CommitTrackingPreferences(delegate, commitResult = false)
        val store = TransactionDraftIdStore(tracked)

        store.rotateAfterAcceptance(ADULT_SCOPE, persistedId)

        assertEquals(persistedId, store.currentId(ADULT_SCOPE))
        assertEquals(persistedId, delegate.getString(ADULT_SCOPE, null))
        assertEquals(1, tracked.commitCalls)
    }

    @Test
    fun `scoped acceptance removes only that scope from persistence`() {
        val original = TransactionDraftIdStore(preferences)
        val adultId = original.currentId(ADULT_SCOPE)
        val masonId = original.currentId(MASON_SCOPE)

        original.rotateAfterAcceptance(ADULT_SCOPE, adultId)

        assertNull(preferences.getString(ADULT_SCOPE, null))
        assertEquals(masonId, preferences.getString(MASON_SCOPE, null))

        val restored = TransactionDraftIdStore(preferences)
        assertNotEquals(adultId, restored.currentId(ADULT_SCOPE))
        assertEquals(masonId, restored.currentId(MASON_SCOPE))
    }

    private companion object {
        const val LEGACY_ADULT_KEY = "bitcoin-buys"
        val ADULT_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.VICTOR,
        )
        val MADDOX_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.MADDOX,
        )
        val MASON_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.MASON,
        )
    }
}

private class CommitTrackingPreferences(
    private val delegate: SharedPreferences,
    private val commitResult: Boolean? = null,
) : SharedPreferences by delegate {
    var commitCalls = 0

    override fun edit(): SharedPreferences.Editor {
        val delegateEditor = delegate.edit()
        return object : SharedPreferences.Editor by delegateEditor {
            override fun putString(key: String?, value: String?): SharedPreferences.Editor {
                delegateEditor.putString(key, value)
                return this
            }

            override fun remove(key: String?): SharedPreferences.Editor {
                delegateEditor.remove(key)
                return this
            }

            override fun commit(): Boolean {
                commitCalls += 1
                return commitResult ?: delegateEditor.commit()
            }
        }
    }
}
