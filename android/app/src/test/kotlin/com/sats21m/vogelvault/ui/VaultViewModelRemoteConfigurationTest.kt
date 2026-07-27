package com.sats21m.vogelvault.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VaultViewModelRemoteConfigurationTest {
    @Test
    fun `manual token configuration failure is visible and remains on fixtures`() {
        val before = VaultUiState().data
        val model =
            VaultViewModel(
                remoteInitiallyEnabled = false,
                enableRemote = { throw IllegalStateException("storage failed") },
            )

        model.enableRemoteRows("dummy-manual-token")

        assertEquals(before, model.state.value.data)
        assertEquals(
            "Authenticated row reads could not be saved securely. Remote reads remain disabled.",
            model.state.value.remoteConfigurationError,
        )
    }

    @Test
    fun `manual token configuration still enables remote loading`() {
        var configured = false
        val model =
            VaultViewModel(
                remoteInitiallyEnabled = false,
                enableRemote = { configured = true },
            )

        model.enableRemoteRows("dummy-manual-token")

        assertEquals(true, configured)
        assertNull(model.state.value.remoteConfigurationError)
        assertEquals("Convex rows", model.state.value.data.transactions.source)
    }
}
