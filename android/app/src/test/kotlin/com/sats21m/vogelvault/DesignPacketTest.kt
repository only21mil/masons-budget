package com.sats21m.vogelvault

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Android design packet.
 *
 * Renders the real Compose shell under Robolectric and writes PNGs, so the UI can
 * be reviewed without an emulator, a display, or a physical device. Mirrors the
 * Linux client's packet.
 *
 * Two device profiles matter for a Pixel Fold, and they are the point of the
 * adaptive layout:
 *   - folded   ~411dp wide  -> bottom navigation bar
 *   - unfolded ~841dp wide  -> navigation rail
 *
 * This is a review artifact, not a pixel-diff gate. It records what the UI looks
 * like; the behavioural assertions live in the domain and ViewModel tests. A
 * strict image comparison would fail on every font or renderer nudge and teach us
 * to ignore it.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = RobolectricDeviceQualifiers.FOLDED)
class DesignPacketTest {

    @get:Rule
    val compose = createComposeRule()

    private fun capture(name: String, state: VaultUiState) {
        compose.setContent {
            VogelVaultTheme {
                VaultApp(
                    state = state,
                    onNavigate = {},
                    onSwitchProfile = {},
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")
    }

    // ── Folded: every destination an adult can open ──────────────────────────

    @Test
    fun foldedAdultDestinations() {
        for (destination in Destination.visibleTo(FamilyMember.VICTOR)) {
            capture(
                "folded-${destination.name.lowercase()}-victor-normal",
                VaultUiState.of(FamilyMember.VICTOR, destination),
            )
        }
    }

    // ── Folded: the child surface ───────────────────────────────────────────

    @Test
    fun foldedChildDestinations() {
        for (destination in Destination.visibleTo(FamilyMember.MASON)) {
            capture(
                "folded-${destination.name.lowercase()}-mason-normal",
                VaultUiState.of(FamilyMember.MASON, destination),
            )
        }
    }

    /** Maddox has no dedicated MC2 budget file, so his budget is genuinely empty. */
    @Test
    fun foldedMaddoxBudgetIsEmpty() {
        capture(
            "folded-budget-maddox-normal",
            VaultUiState.of(FamilyMember.MADDOX, Destination.BUDGET),
        )
    }

    // ── Folded: the non-normal states ───────────────────────────────────────

    @Test
    fun foldedStates() {
        val sampled = listOf(
            Destination.DASHBOARD,
            Destination.BUDGET,
            Destination.ACTIVITY,
            Destination.NET_WORTH,
        )
        val states = listOf(Freshness.STALE, Freshness.ERROR, Freshness.EMPTY, Freshness.LOADING)
        for (destination in sampled) {
            for (status in states) {
                capture(
                    "folded-${destination.name.lowercase()}-victor-${status.name.lowercase()}",
                    VaultUiState.of(FamilyMember.VICTOR, destination, status),
                )
            }
        }
    }
}

/**
 * Unfolded pass.
 *
 * A separate class because the Robolectric device qualifier is class-level, and
 * the whole point is proving the layout switches from bottom bar to rail.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = RobolectricDeviceQualifiers.UNFOLDED)
class DesignPacketUnfoldedTest {

    @get:Rule
    val compose = createComposeRule()

    private fun capture(name: String, state: VaultUiState) {
        compose.setContent {
            VogelVaultTheme {
                VaultApp(
                    state = state,
                    onNavigate = {},
                    onSwitchProfile = {},
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")
    }

    @Test
    fun unfoldedAdultDestinations() {
        for (destination in Destination.visibleTo(FamilyMember.VICTOR)) {
            capture(
                "unfolded-${destination.name.lowercase()}-victor-normal",
                VaultUiState.of(FamilyMember.VICTOR, destination),
            )
        }
    }

    @Test
    fun unfoldedChildDashboard() {
        capture(
            "unfolded-dashboard-mason-normal",
            VaultUiState.of(FamilyMember.MASON, Destination.DASHBOARD),
        )
    }
}

/**
 * Robolectric screen qualifiers for the two Fold postures.
 *
 * Written out rather than using a named device so the widths line up with
 * [com.sats21m.vogelvault.ui.UNFOLDED_MIN_WIDTH_DP] on purpose: 411dp is below the
 * 600dp threshold, 841dp is above it.
 */
object RobolectricDeviceQualifiers {
    const val FOLDED = "w411dp-h891dp-normal-long-notround-any-420dpi-keyshidden-nonav"
    const val UNFOLDED = "w841dp-h945dp-normal-long-notround-any-420dpi-keyshidden-nonav"
}
