package com.sats21m.vogelvault

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
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
        const val ADULT_SCOPE = "transactions"
        const val MASON_SCOPE = "mason-transactions"
    }
}
