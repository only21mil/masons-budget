package com.sats21m.vogelvault.ui.theme

import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.VaultButton
import com.sats21m.vogelvault.ui.components.LedgerTextField
import com.sats21m.vogelvault.ui.components.LedgerRevealMarks
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidPolishTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    @Before fun start() { controller.get().setTheme(R.style.Theme_VogelVault); controller.setup() }
    @After fun stop() {
        Settings.Global.putFloat(controller.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        controller.pause().stop().destroy()
    }

    @Test fun systemAnimationScaleUpdatesTheActiveTheme() {
        var animate = true
        controller.get().setContent { LedgerTheme(LedgerTreatment.TERMINAL_DARK) { animate = LocalLedgerEffects.current.animate } }
        compose.waitForIdle()
        assertTrue(animate)
        val resolver = controller.get().contentResolver
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        resolver.notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), null)
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        compose.waitForIdle()
        assertFalse(animate)
    }

    @Test fun buttonAndFieldMeetThe48dpFloor() {
        controller.get().setContent { LedgerTheme(LedgerTreatment.DAYLIGHT_LIGHT) {
            Column {
                VaultButton("Save", {}, Modifier.testTag("button"))
                LedgerTextField("", {}, label = "Account name", modifier = Modifier.testTag("field"))
            }
        } }
        compose.onNodeWithTag("button").assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("field").assertHeightIsAtLeast(48.dp)
    }

    @Test fun foldedTypographyAndFirstArrivalStayStableAcrossRefresh() {
        LedgerTreatment.entries.forEach { assertEquals(14.sp, themeTokens(it, folded = true).type.rowPrimary.fontSize) }
        val section = java.util.UUID.randomUUID().toString()
        assertTrue(LedgerRevealMarks.staggers("victor" to section, 0))
        assertFalse(LedgerRevealMarks.staggers("victor" to section, 10_000))
        assertTrue(LedgerRevealMarks.staggers("mason" to section, 10_000))
        assertFalse(LedgerRevealMarks.staggers("victor" to section, 20_000))
    }
}
