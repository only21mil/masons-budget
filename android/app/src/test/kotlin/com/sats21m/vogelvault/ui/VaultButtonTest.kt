package com.sats21m.vogelvault.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSurfaceRaised
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VaultButtonTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `primary actions use graphite fill without consuming the orange accent`() {
        var labelColor: Color? = null
        var containerColor: Color? = null
        var primaryColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    primaryColor = MaterialTheme.colorScheme.primary
                    containerColor = vaultButtonColors().containerColor
                    VaultButton(onClick = {}) {
                        Text(
                            text = "Action",
                            onTextLayout = { labelColor = it.layoutInput.style.color },
                        )
                    }
                }
            }
        }
        compose.waitForIdle()

        assertEquals(VaultSurfaceRaised, containerColor)
        assertEquals(VaultCream, labelColor)
        assertEquals(VaultAccent, primaryColor)
    }
}
