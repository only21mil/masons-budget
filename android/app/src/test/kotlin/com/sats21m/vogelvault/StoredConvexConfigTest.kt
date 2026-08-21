package com.sats21m.vogelvault

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ReadReadiness
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.ui.VaultViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame

class StoredConvexConfigTest {
    @Test
    fun `allowed encrypted stored configuration seeds startup`() {
        val stored =
            ConvexConfig(
                deploymentUrl = PRODUCTION_DEPLOYMENT,
                readToken = "dummy-stored-token",
                remoteReadEnabled = true,
            )

        assertSame(stored, initialConvexConfig(stored))
    }

    @Test
    fun `fresh install preserves fixtures with remote reads disabled`() {
        val config = initialConvexConfig(ConvexConfig())
        val model = VaultViewModel(remoteInitiallyEnabled = config.allowsRemoteRead)

        assertFalse(config.hasReadToken)
        assertFalse(config.allowsRemoteRead)
        assertEquals(ReadReadiness.DISABLED, config.readiness)
        assertEquals(
            Fixtures.envelope(model.state.value.activeProfile),
            model.state.value.data,
        )
    }

    @Test
    fun `disabled stored configuration cannot enable startup`() {
        val config =
            initialConvexConfig(
                ConvexConfig(
                    deploymentUrl = PRODUCTION_DEPLOYMENT,
                    readToken = "dummy-stored-token",
                    remoteReadEnabled = false,
                ),
            )

        assertFalse(config.hasReadToken)
        assertFalse(config.allowsRemoteRead)
        assertEquals(ReadReadiness.DISABLED, config.readiness)
    }

    @Test
    fun `write route is available without reusing a read credential`() {
        val config = writeConvexConfig()

        assertEquals(PRODUCTION_DEPLOYMENT, config.deploymentUrl)
        assertFalse(config.hasReadToken)
        assertFalse(config.allowsRemoteRead)
    }
}
