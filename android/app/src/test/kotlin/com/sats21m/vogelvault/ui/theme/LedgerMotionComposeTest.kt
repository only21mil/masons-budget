package com.sats21m.vogelvault.ui.theme

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.SnapSpec
import androidx.compose.animation.core.TweenSpec
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.ui.BitcoinPriceHero
import com.sats21m.vogelvault.ui.components.revealWithinWindow
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerMotionComposeTest {
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

    private fun render(
        reduceMotion: Boolean = false,
        content: @androidx.compose.runtime.Composable () -> Unit,
    ) {
        compose.runOnUiThread {
            activityController.get().setContent {
                SovereignLedgerTheme(
                    treatment = LedgerTreatment.TERMINAL_DARK,
                    accessibility = LedgerAccessibilityPreferences(reduceMotion = reduceMotion),
                    content = content,
                )
            }
        }
        compose.waitForIdle()
    }

    /**
     * Drives [frames] test-clock frames. The paused main looper is idled so
     * snapshot writes reach the recomposer, and waitForIdle runs the
     * recomposition each frame requests.
     */
    private fun settle(frames: Int, change: () -> Unit = {}) {
        compose.runOnUiThread(change)
        repeat(frames) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
        }
    }

    @Test
    fun `ledgerTween reads the reduce motion preference from the theme`() {
        var withMotion: FiniteAnimationSpec<Float>? = null
        var withoutMotion: FiniteAnimationSpec<Float>? = null

        render { withMotion = ledgerTween(300) }
        render(reduceMotion = true) { withoutMotion = ledgerTween(300) }

        assertEquals(300, assertIs<TweenSpec<Float>>(withMotion).durationMillis)
        assertIs<SnapSpec<Float>>(withoutMotion)
    }

    @Test
    fun `hero prints cold then settles toward a new price over the settle window`() {
        var priceCents by mutableStateOf(9_425_012L)
        compose.mainClock.autoAdvance = false
        render { BitcoinPriceHero(quote(priceCents)) }
        compose.onNodeWithText("$94,250").assertIsDisplayed()

        // Nine frames is roughly 150ms, about half the 300ms settle.
        settle(frames = 9) { priceCents = 9_525_012L }
        val midway = compose.heroIntegerTexts()
        assertTrue(midway.none { it == "$94,250" || it == "$95,250" }, "mid-settle figure: $midway")

        settle(frames = LedgerMotion.progressAndThemeMillis / 16 + 2)
        compose.onNodeWithText("$95,250").assertIsDisplayed()
    }

    @Test
    fun `hero snaps to a new price under reduce motion`() {
        var priceCents by mutableStateOf(9_425_012L)
        compose.mainClock.autoAdvance = false
        render(reduceMotion = true) { BitcoinPriceHero(quote(priceCents)) }
        compose.onNodeWithText("$94,250").assertIsDisplayed()

        // Snap still takes the effect's first frame to land, so allow three frames, not 300ms.
        settle(frames = 3) { priceCents = 9_525_012L }
        assertEquals(listOf("$95,250"), compose.heroIntegerTexts())
    }

    @Test
    fun `rows arriving inside the window stagger and later scroll-ins print cold`() {
        assertTrue(revealWithinWindow(firstSeenMillis = 1_000L, nowMillis = 1_000L))
        assertTrue(revealWithinWindow(firstSeenMillis = 1_000L, nowMillis = 1_400L))
        assertFalse(revealWithinWindow(firstSeenMillis = 1_000L, nowMillis = 1_401L))
        assertFalse(revealWithinWindow(firstSeenMillis = 1_000L, nowMillis = 900L))
    }

    private fun quote(priceCents: Long) = MarketQuote(
        symbol = MarketSymbol.BTC,
        priceCents = priceCents,
        source = "Vogel price service",
        fetchedAt = "2026-08-26T12:00:00Z",
        status = MarketQuoteStatus.LIVE,
    )
}

private fun ComposeTestRule.heroIntegerTexts(): List<String> =
    onAllNodes(hasText("$", substring = true))
        .fetchSemanticsNodes()
        .flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.map { it.text }.orEmpty()
        }
