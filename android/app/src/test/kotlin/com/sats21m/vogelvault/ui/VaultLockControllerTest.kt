package com.sats21m.vogelvault.ui

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
        assertTrue(requiresOnboarding(remoteReadReady = false))
        assertFalse(requiresOnboarding(remoteReadReady = true))
    }

    @Test
    fun `share return within thirty seconds keeps the vault open only once`() {
        var now = 0L
        val controller = unlockedController { now }
        controller.externalActivityLaunched()
        controller.backgrounded()
        now = 29_999
        controller.foregrounded()
        assertTrue(controller.snapshot().isUnlocked)
        controller.backgrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `share return at thirty seconds locks the vault`() {
        var now = 0L
        val controller = unlockedController { now }
        controller.externalActivityLaunched()
        controller.backgrounded()
        now = 30_000
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `failed or stale share launch cannot grant later background grace`() {
        var now = 0L
        val failed = unlockedController { now }
        failed.externalActivityLaunched()
        failed.externalActivityLaunchFailed()
        failed.backgrounded()
        assertFalse(failed.snapshot().isUnlocked)
        val stale = unlockedController { now }
        stale.externalActivityLaunched()
        now = 30_000
        stale.backgrounded()
        assertFalse(stale.snapshot().isUnlocked)
    }

    @Test
    fun `share launch cannot unlock a locked vault`() {
        val controller = VaultLockController()
        controller.externalActivityLaunched()
        controller.backgrounded()
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `Home during profile prompt locks before a later cancellation and return`() {
        var now = 0L
        val controller = unlockedController { now }
        controller.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.MASON)
        controller.backgrounded()
        assertFalse(controller.snapshot().isUnlocked)
        assertTrue(controller.snapshot().isAuthenticating)
        now = 1_000
        controller.authenticationErrored("Cancelled")
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
        assertTrue(controller.beginAppUnlock())
    }

    @Test
    fun `Home after profile prompt cancellation locks the previous session`() {
        val controller = unlockedController()
        controller.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.MASON)
        controller.authenticationErrored("Cancelled")
        controller.backgrounded()
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `cancelled app launched credential authentication retains the session only within grace`() {
        var now = 0L
        val quick = unlockedController { now }
        quick.beginProfileSwitch(FamilyMember.MASON, FamilyMember.VICTOR)
        quick.externalActivityLaunched()
        quick.backgrounded()
        now = 29_999
        quick.authenticationErrored("Cancelled")
        quick.foregrounded()
        assertTrue(quick.snapshot().isUnlocked)
        val expired = unlockedController { now }
        expired.beginProfileSwitch(FamilyMember.MASON, FamilyMember.VICTOR)
        expired.externalActivityLaunched()
        expired.backgrounded()
        now += 30_000
        expired.foregrounded()
        expired.authenticationErrored("Cancelled")
        assertFalse(expired.snapshot().isUnlocked)
    }

    @Test
    fun `credential cancellation before stop cannot arm a later Home transition`() {
        val controller = unlockedController()
        controller.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.MASON)
        controller.externalActivityLaunched()
        controller.authenticationErrored("Cancelled")
        controller.backgrounded()
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `Home while credential callback is pending after return revokes grace`() {
        val controller = unlockedController()
        controller.beginProfileSwitch(FamilyMember.VICTOR, FamilyMember.MASON)
        controller.externalActivityLaunched()
        controller.backgrounded()
        controller.foregrounded()
        controller.backgrounded()
        controller.authenticationErrored("Cancelled")
        controller.foregrounded()
        assertFalse(controller.snapshot().isUnlocked)
    }

    @Test
    fun `slow successful system authentication still authorizes its exact request`() {
        var now = 0L
        val controller = unlockedController { now }
        controller.beginProfileSwitch(FamilyMember.MASON, FamilyMember.VICTOR)
        controller.backgrounded()
        now = 60_000
        controller.foregrounded()
        assertEquals(FamilyMember.VICTOR, controller.authenticationSucceeded())
        controller.foregrounded()
        assertTrue(controller.snapshot().isUnlocked)
    }

    private fun unlockedController(nowMillis: () -> Long = { 0L }): VaultLockController =
        VaultLockController(nowMillis).also { controller ->
            assertTrue(controller.beginAppUnlock())
            assertNull(controller.authenticationSucceeded())
        }
}
