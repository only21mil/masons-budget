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
    fun `legacy bitcoin buy ids migrate once into requested scopes without leaking`() {
        val adultLegacyId = "android-legacy-adult"
        val masonLegacyId = "android-legacy-mason"
        assertEquals(
            true,
            preferences.edit()
                .putString(LEGACY_ADULT_KEY, adultLegacyId)
                .putString(LEGACY_MASON_KEY, masonLegacyId)
                .commit(),
        )

        val store = TransactionDraftIdStore(preferences)

        assertEquals(adultLegacyId, store.currentId(ADULT_SCOPE))
        assertEquals(masonLegacyId, store.currentId(MASON_SCOPE))
        assertNotEquals(adultLegacyId, masonLegacyId)
        assertNotEquals(adultLegacyId, store.currentId(RACHEL_SCOPE))
        assertNotEquals(adultLegacyId, store.currentId(INCOME_SCOPE))
        assertEquals(adultLegacyId, preferences.getString(ADULT_SCOPE, null))
        assertEquals(masonLegacyId, preferences.getString(MASON_SCOPE, null))
        assertNull(preferences.getString(LEGACY_ADULT_KEY, null))
        assertNull(preferences.getString(LEGACY_MASON_KEY, null))

        val restored = TransactionDraftIdStore(preferences)
        assertEquals(adultLegacyId, restored.currentId(ADULT_SCOPE))
        assertEquals(masonLegacyId, restored.currentId(MASON_SCOPE))
        assertNotEquals(adultLegacyId, restored.currentId(INCOME_SCOPE))
    }

    @Test
    fun `legacy migration derives every bitcoin buy owner from the family domain`() {
        FamilyMember.entries.forEach { profile ->
            val legacyId = "android-legacy-${profile.key}"
            val scope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, profile)
            assertEquals(
                true,
                preferences.edit()
                    .clear()
                    .putString(profile.btcBuysDataFileName, legacyId)
                    .commit(),
            )

            val store = TransactionDraftIdStore(preferences)

            assertEquals(legacyId, store.currentId(scope), profile.key)
            assertNull(preferences.getString(profile.btcBuysDataFileName, null), profile.key)
        }
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
        const val LEGACY_MASON_KEY = "mason-bitcoin-buys"
        val ADULT_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.VICTOR,
        )
        val RACHEL_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.RACHEL,
        )
        val MASON_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.STANDALONE,
            profile = FamilyMember.MASON,
        )
        val INCOME_SCOPE = btcBuyDraftIdScope(
            surface = BtcBuyWriteSurface.INCOME_LINKED,
            profile = FamilyMember.VICTOR,
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
