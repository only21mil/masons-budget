package com.sats21m.vogelvault

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.ConvexValue
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.BtcBuySaveOutcome
import com.sats21m.vogelvault.ui.BtcBuyWriteSurface
import com.sats21m.vogelvault.ui.btcBuyDraftIdScope
import com.sats21m.vogelvault.ui.btcBuySaveOutcome
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonPrimitive
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
    fun `every bitcoin buy scope owns a distinct pending id`() {
        val legacyId = "android-legacy-adult"
        val scopes = BtcBuyWriteSurface.entries.flatMap { surface ->
            FamilyMember.entries.map { profile -> btcBuyDraftIdScope(surface, profile) }
        }
        assertEquals(true, preferences.edit().putString(LEGACY_ADULT_KEY, legacyId).commit())
        val store = TransactionDraftIdStore(preferences)

        val pendingIdsByScope = scopes.associateWith(store::currentId)

        assertEquals(scopes.size, pendingIdsByScope.values.toSet().size)
        pendingIdsByScope.forEach { (scope, pendingId) ->
            assertNotEquals(legacyId, pendingId, scope)
            assertEquals(pendingId, preferences.getString(scope, null), scope)
        }
        assertEquals(legacyId, preferences.getString(LEGACY_ADULT_KEY, null))
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
    fun `failed acceptance clear reports the stale durable lease`() {
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

        val rotated = store.rotateAfterAcceptance(ADULT_SCOPE, persistedId)

        assertEquals<Any?>(false, rotated)
        assertEquals(persistedId, store.currentId(ADULT_SCOPE))
        assertEquals(persistedId, delegate.getString(ADULT_SCOPE, null))
        assertEquals(persistedId, TransactionDraftIdStore(delegate).currentId(ADULT_SCOPE))
        assertEquals(1, tracked.commitCalls)
    }

    @Test
    fun `accepted buy with a stale lease becomes a visible failure`() {
        val accepted =
            ConvexResult.Ok(
                ConvexValue(
                    parsed = JsonPrimitive("written"),
                    rawResponseJson = """{"status":"success"}""",
                ),
            )

        assertIs<BtcBuySaveOutcome.AcceptedLeaseResetFailed>(
            btcBuySaveOutcome(accepted, leaseReset = false),
        )
    }

    @Test
    fun `accepted draft write with a stale lease becomes a recovery outcome`() {
        val accepted =
            ConvexResult.Ok(
                ConvexValue(
                    parsed = JsonPrimitive("written"),
                    rawResponseJson = """{"status":"success"}""",
                ),
            )

        assertIs<DraftIdWriteOutcome.AcceptedLeaseResetFailed>(
            draftIdWriteOutcome(accepted, leaseReset = false),
        )
    }

    @Test
    fun `accepted draft write with a stale lease still announces server acceptance`() {
        var acceptedSignals = 0

        DraftIdWriteOutcome.AcceptedLeaseResetFailed.onServerAccepted {
            acceptedSignals += 1
        }

        assertEquals(1, acceptedSignals)
    }

    @Test
    fun `rejected draft write does not announce server acceptance`() {
        var acceptedSignals = 0

        DraftIdWriteOutcome.Rejected<Nothing>(
            ConvexResult.Failed("transport failure"),
        ).onServerAccepted {
            acceptedSignals += 1
        }

        assertEquals(0, acceptedSignals)
    }

    @Test
    fun `every production draft rotation observes its result`() {
        val callSites = mutableListOf<Triple<Path, String, String>>()
        Files.walk(Path.of("src/main/kotlin")).use { paths ->
            paths
                .filter { path -> path.toString().endsWith(".kt") }
                .forEach { path ->
                    val lines = Files.readAllLines(path)
                    lines.forEachIndexed { index, rawLine ->
                        val line = rawLine.trim()
                        if (
                            "rotateAfterAcceptance(" in line &&
                            !line.startsWith("fun rotateAfterAcceptance(")
                        ) {
                            callSites +=
                                Triple(path, line, lines.getOrNull(index - 1)?.trim().orEmpty())
                        }
                    }
                }
            }

        // Standalone income and ordinary transactions each rotate their own lease.
        assertEquals(7, callSites.size, callSites.joinToString("\n"))
        callSites.forEach { (path, line, previousLine) ->
            val callPrefix = line.substringBefore("rotateAfterAcceptance(")
            val acceptedWriteGuard = "result !is ConvexResult.Ok ||"
            assertEquals(
                true,
                acceptedWriteGuard in previousLine || acceptedWriteGuard in callPrefix,
                "$path discards the draft-rotation result: $line",
            )
        }
    }

    @Test
    fun `scoped acceptance removes only that scope from persistence`() {
        val original = TransactionDraftIdStore(preferences)
        val adultId = original.currentId(ADULT_SCOPE)
        val masonId = original.currentId(MASON_SCOPE)

        assertEquals(true, original.rotateAfterAcceptance(ADULT_SCOPE, adultId))

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
