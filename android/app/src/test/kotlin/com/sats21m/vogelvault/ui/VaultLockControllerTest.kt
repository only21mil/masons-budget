package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ReadReadiness
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VaultLockControllerTest {
    @Test
    fun `the vault locks whenever an unlocked app backgrounds`() {
        val controller = unlockedController()

        controller.backgrounded()

        assertFalse(controller.snapshot().isUnlocked)
        assertFalse(controller.snapshot().isAuthenticating)
    }

    @Test
    fun `profile target is withheld until authentication succeeds`() {
        val controller = unlockedController()

        assertTrue(
            controller.beginProfileSwitch(
                current = FamilyMember.VICTOR,
                target = FamilyMember.MASON,
            ),
        )
        assertTrue(controller.snapshot().isAuthenticating)

        val approvedTarget = controller.authenticationSucceeded()

        assertEquals(FamilyMember.MASON, approvedTarget)
        assertTrue(controller.snapshot().isUnlocked)
    }

    @Test
    fun `failed profile authentication does not return a target`() {
        val controller = unlockedController()
        controller.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.RACHEL)

        controller.authenticationErrored("Canceled")

        assertFalse(controller.snapshot().isAuthenticating)
        assertTrue(controller.snapshot().isUnlocked)
        assertEquals("Canceled", controller.snapshot().error)
    }

    @Test
    fun `unconfigured clients require onboarding and ready clients do not`() {
        assertTrue(requiresOnboarding(ReadReadiness.DISABLED))
        assertTrue(requiresOnboarding(ReadReadiness.NO_READ_TOKEN))
        assertFalse(requiresOnboarding(ReadReadiness.READY))
    }

    private fun unlockedController(): VaultLockController =
        VaultLockController().also { controller ->
            assertTrue(controller.beginAppUnlock())
            assertNull(controller.authenticationSucceeded())
        }
}
