package com.sats21m.vogelvault.ui.theme

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.sats21m.vogelvault.R
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
class VogelVaultThemeTest {
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
    fun unstyledTextUsesCreamOnTheRootCanvas() {
        var resolvedColor: Color? = null

        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Text(
                        text = "Unstyled text",
                        onTextLayout = { resolvedColor = it.layoutInput.style.color },
                    )
                }
            }
        }
        compose.waitForIdle()

        assertEquals(VaultCream, resolvedColor)
    }
}
