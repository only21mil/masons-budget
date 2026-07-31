package com.sats21m.vogelvault.ui

import android.Manifest
import androidx.activity.compose.setContent
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.fragment.app.FragmentActivity
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import kotlin.test.assertContentEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BudgetNotificationPermissionTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<FragmentActivity>
    private lateinit var notifications: BudgetNotificationController

    @Before
    fun startSettingsHostWithoutNotificationPermission() {
        activityController = Robolectric.buildActivity(FragmentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
        shadowOf(activityController.get()).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifications = BudgetNotificationController(activityController.get())
        notifications.setEnabled(FamilyMember.VICTOR, false)
    }

    @After
    fun stopSettingsHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `enabling notifications requests Android permission from the production host`() {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    BudgetNotificationSettings(VaultUiState.of(FamilyMember.VICTOR))
                }
            }
        }
        compose.waitForIdle()

        compose.onNode(hasClickAction()).performClick()

        val request = shadowOf(activityController.get()).lastRequestedPermission
        assertContentEquals(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            request.requestedPermissions,
            "The settings switch did not launch the Android notification permission request.",
        )
        assertTrue(
            request.requestCode > 0xffff,
            "The test did not exercise ActivityResultRegistry's request-code namespace.",
        )
        assertFalse(
            notifications.isEnabled(FamilyMember.VICTOR),
            "Notification delivery was enabled before Android granted the permission.",
        )
    }
}
