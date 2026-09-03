package com.sats21m.vogelvault.ui

import androidx.compose.material3.SnackbarHostState
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexDeviceCredential
import com.sats21m.vogelvault.data.ConvexDeviceCredentialSource
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.HttpTextResponse
import com.sats21m.vogelvault.data.MutableConvexConfigSource
import com.sats21m.vogelvault.data.RecordingPoster
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.TodoItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class TodoWriteAuthorityStateTest {
    @Test
    fun `accepted update keeps cached row blocked until a newer authoritative revision arrives`() {
        val baseRevision = 1_800_000_000_000L
        val original = TodoItem(
            id = "authority-task",
            title = "Original",
            owner = FamilyMember.MASON,
            updatedAtMs = baseRevision,
        )
        val localEdit = original.copy(title = "Local edit", updatedAtMs = baseRevision + 900)
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"${original.id}","outcome":"updated"}}""",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var accepted: TodoItem? = null
        var refreshes = 0
        val state = TodoWriteState(
            gateway = TodoMutationGateway(
                ConvexDeviceMutationClient(
                    configSource = MutableConvexConfigSource(
                        ConvexConfig(deploymentUrl = "https://todo-device-test.convex.cloud"),
                    ),
                    credentialSource = ConvexDeviceCredentialSource {
                        ConvexDeviceCredential(
                            "test-device",
                            "t".repeat(43),
                            FamilyMember.MASON,
                        )
                    },
                    http = poster,
                ),
            ),
            activeProfile = FamilyMember.MASON,
            scope = scope,
            snackbar = SnackbarHostState(),
            nowMillis = { baseRevision },
            onWriteSucceeded = { refreshes += 1 },
            onCredentialRejected = { null },
            deletedMessage = { "deleted" },
            undoLabel = "Undo",
        )

        state.upsert(localEdit, baseRevision, TodoWriteAction.UPDATE) { accepted = it }

        assertEquals(baseRevision, assertNotNull(accepted).updatedAtMs)
        assertEquals(1, refreshes)
        assertTrue(original.id in state.busyIds)

        state.filterIncoming(listOf(original))
        assertTrue(original.id in state.busyIds, "a stale cache row reopened the write path")

        val authoritative = localEdit.copy(updatedAtMs = baseRevision + 1)
        assertEquals(listOf(authoritative), state.filterIncoming(listOf(authoritative)))
        assertFalse(original.id in state.busyIds)
        scope.cancel()
    }

    @Test
    fun `zero-revision rows release the busy flag when authority echoes zero back`() {
        val original = TodoItem(
            id = "migrated-task",
            title = "Original",
            owner = FamilyMember.MASON,
            updatedAtMs = 0L,
        )
        val localEdit = original.copy(title = "Local edit")
        val poster = RecordingPoster(
            HttpTextResponse(
                200,
                """{"status":"success","value":{"ok":true,"entityId":"${original.id}","outcome":"updated"}}""",
            ),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var refreshes = 0
        val state = TodoWriteState(
            gateway = TodoMutationGateway(
                ConvexDeviceMutationClient(
                    configSource = MutableConvexConfigSource(
                        ConvexConfig(deploymentUrl = "https://todo-device-test.convex.cloud"),
                    ),
                    credentialSource = ConvexDeviceCredentialSource {
                        ConvexDeviceCredential(
                            "test-device",
                            "t".repeat(43),
                            FamilyMember.MASON,
                        )
                    },
                    http = poster,
                ),
            ),
            activeProfile = FamilyMember.MASON,
            scope = scope,
            snackbar = SnackbarHostState(),
            nowMillis = { 1_000L },
            onWriteSucceeded = { refreshes += 1 },
            onCredentialRejected = { null },
            deletedMessage = { "deleted" },
            undoLabel = "Undo",
        )

        state.upsert(localEdit, baseUpdatedAtMs = 0L, TodoWriteAction.UPDATE) { }
        assertEquals(1, refreshes)
        assertTrue(original.id in state.busyIds)

        // The migrated row's revision never advances: authority echoes 0 at 0.
        // That equality is the only confirmation this write can produce, so
        // the row must not stay disabled until an unrelated refresh happens
        // to mint a larger revision.
        assertEquals(listOf(original), state.filterIncoming(listOf(original)))
        assertFalse(original.id in state.busyIds)
        scope.cancel()
    }
}
