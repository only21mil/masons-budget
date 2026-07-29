package com.sats21m.vogelvault

import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ReadReadiness
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.ui.VaultViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BuildTimeConvexConfigTest {
    @Test
    fun `baked token seeds fresh install without stored configuration`() {
        val startupConfig =
            initialConvexConfig(
                buildTime = buildTimeConvexConfig("dummy-build-token"),
                stored = ConvexConfig(),
            )

        assertTrue(startupConfig.hasReadToken)
        assertTrue(startupConfig.allowsRemoteRead)
        assertEquals(ReadReadiness.READY, startupConfig.readiness)
    }

    @Test
    fun `non-blank build token enables authenticated production reads`() {
        val config = buildTimeConvexConfig("dummy-build-token")

        assertEquals(PRODUCTION_DEPLOYMENT, config.deploymentUrl)
        assertTrue(config.hasReadToken)
        assertTrue(config.allowsRemoteRead)
        assertEquals(ReadReadiness.READY, config.readiness)
    }

    @Test
    fun `absent build token preserves fixtures with remote reads disabled`() {
        val config =
            initialConvexConfig(
                buildTime = buildTimeConvexConfig(""),
                stored = ConvexConfig(),
            )
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
    fun `write route is available without reusing a read credential`() {
        val config = writeConvexConfig()

        assertEquals(PRODUCTION_DEPLOYMENT, config.deploymentUrl)
        assertFalse(config.hasReadToken)
        assertFalse(config.allowsRemoteRead)
    }
}
