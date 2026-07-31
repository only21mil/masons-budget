package com.sats21m.vogelvault.ui

import android.os.Looper
import com.sats21m.vogelvault.domain.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
        val effectiveReadReady = MutableStateFlow(false)
        val model =
            VaultViewModel(
                remoteInitiallyEnabled = false,
                effectiveReadReady = effectiveReadReady,
                enableRemote = {
                    configured = true
                    effectiveReadReady.value = true
                },
            )

        model.enableRemoteRows("dummy-manual-token")

        assertEquals(true, configured)
        assertNull(model.state.value.remoteConfigurationError)
        assertEquals("Convex rows", model.state.value.data.transactions.source)
    }

    @Test
    fun `stored bootstrap activation enables loading without passing a credential`() {
        val effectiveReadReady = MutableStateFlow(false)
        val model =
            VaultViewModel(
                remoteInitiallyEnabled = false,
                effectiveReadReady = effectiveReadReady,
            )

        effectiveReadReady.value = true
        model.enableStoredRemoteRows()

        assertNull(model.state.value.remoteConfigurationError)
        assertEquals("Convex rows", model.state.value.data.transactions.source)
    }

    @Test
    fun `effective rejection disables remote state and restores enrollment fixtures`() {
        val effectiveReadReady = MutableStateFlow(true)
        val model = VaultViewModel(effectiveReadReady = effectiveReadReady)
        assertEquals("Convex rows", model.state.value.data.transactions.source)

        effectiveReadReady.value = false
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(effectiveReadReady.value)
        assertEquals(
            Fixtures.envelope(model.state.value.activeProfile),
            model.state.value.data,
        )
        assertNull(model.state.value.financeDocument)
    }
}
