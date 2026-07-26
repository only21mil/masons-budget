package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.CurrencyBitcoin
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.ui.components.Badge
import com.sats21m.vogelvault.ui.components.FreshnessTag
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.theme.LocalIsUnfolded
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultAccentDim
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurfaceSunken
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted

/**
 * Destinations.
 *
 * `adultOnly` is enforced by the shell, not just hidden from the bar — a child
 * profile must not be able to land on an adult surface even if state is restored
 * or forced.
 */
enum class Destination(
    val label: String,
    val icon: ImageVector,
    val adultOnly: Boolean = false,
) {
    DASHBOARD("Dashboard", Icons.Filled.Dashboard),
    ACTIVITY("Activity", Icons.Filled.ReceiptLong),
    BUDGET("Budget", Icons.Filled.Payments),
    BITCOIN("Bitcoin", Icons.Filled.CurrencyBitcoin),
    NET_WORTH("Net Worth", Icons.Filled.AccountBalance),
    TODAY("Today", Icons.Filled.WbSunny),
    FAMILY("Family", Icons.Filled.People),
    SETTINGS("Settings", Icons.Filled.Settings);

    companion object {
        fun visibleTo(member: FamilyMember): List<Destination> =
            entries.filter { member.isAdult || !it.adultOnly }
    }
}

/**
 * The unfolded threshold.
 *
 * A Pixel Fold is ~840dp wide unfolded and ~370dp folded, so 600dp cleanly
 * separates the two without depending on a hinge API. Named rather than inlined
 * so the screenshot tests assert against the same number the UI uses.
 */
const val UNFOLDED_MIN_WIDTH_DP = 600

@Composable
fun VaultApp(
    state: VaultUiState,
    onNavigate: (Destination) -> Unit,
    onSwitchProfile: (FamilyMember) -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier.fillMaxSize().background(VaultBlack)) {
        val unfolded = maxWidth.value >= UNFOLDED_MIN_WIDTH_DP

        CompositionLocalProvider(LocalIsUnfolded provides unfolded) {
            val destinations = Destination.visibleTo(state.activeProfile)
            // A profile switch can strand the user on a destination they may no
            // longer open. Fall back rather than render an empty shell.
            val current = if (state.destination in destinations) state.destination else Destination.DASHBOARD

            if (unfolded) {
                Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    VaultRail(destinations, current, onNavigate)
                    Column(Modifier.weight(1f)) {
                        VaultTopBar(state, onSwitchProfile)
                        HorizontalHairline()
                        ScreenHost(current, state, Modifier.weight(1f))
                    }
                }
            } else {
                Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    VaultTopBar(state, onSwitchProfile)
                    HorizontalHairline()
                    ScreenHost(current, state, Modifier.weight(1f))
                    HorizontalHairline()
                    VaultBottomBar(destinations, current, onNavigate)
                }
            }
        }
    }
}

@Composable
private fun VaultRail(
    destinations: List<Destination>,
    current: Destination,
    onNavigate: (Destination) -> Unit,
) {
    NavigationRail(
        containerColor = VaultSurfaceSunken,
        header = {
            Spacer(Modifier.height(VaultSpace.md))
            Icon(Icons.Filled.AccountBalance, contentDescription = null, tint = VaultAccent)
        },
    ) {
        destinations.forEach { destination ->
            NavigationRailItem(
                selected = destination == current,
                onClick = { onNavigate(destination) },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label, style = MaterialTheme.typography.labelSmall) },
                colors = NavigationRailItemDefaults.colors(
                    selectedIconColor = VaultCream,
                    selectedTextColor = VaultCream,
                    indicatorColor = VaultAccentDim,
                    unselectedIconColor = VaultTextMuted,
                    unselectedTextColor = VaultTextDim,
                ),
            )
        }
    }
}

@Composable
private fun VaultBottomBar(
    destinations: List<Destination>,
    current: Destination,
    onNavigate: (Destination) -> Unit,
) {
    // Folded, a Pixel Fold cannot carry eight labelled tabs. Show the five most
    // used and reach the rest by unfolding or from Settings.
    val folded = destinations.take(5)
    NavigationBar(containerColor = VaultSurfaceSunken) {
        folded.forEach { destination ->
            NavigationBarItem(
                selected = destination == current,
                onClick = { onNavigate(destination) },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label, style = MaterialTheme.typography.labelSmall) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = VaultCream,
                    selectedTextColor = VaultCream,
                    indicatorColor = VaultAccentDim,
                    unselectedIconColor = VaultTextMuted,
                    unselectedTextColor = VaultTextDim,
                ),
            )
        }
    }
}

@Composable
private fun VaultTopBar(state: VaultUiState, onSwitchProfile: (FamilyMember) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(VaultSurfaceSunken)
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            state.activeProfile.displayName,
            style = MaterialTheme.typography.titleMedium,
            color = VaultCream,
        )
        Spacer(Modifier.width(VaultSpace.sm))
        if (!state.activeProfile.isAdult) {
            Badge("Child profile")
        } else {
            // Adults can move between profiles; children cannot, so no control is
            // offered to them at all rather than a disabled one.
            state.switchTargets
                .filter { it != state.activeProfile }
                .forEach { target ->
                    Badge(target.displayName, accented = false)
                    Spacer(Modifier.width(VaultSpace.xs))
                }
        }
        Spacer(Modifier.weight(1f))
        Text("SYNC", style = MaterialTheme.typography.labelSmall, color = VaultTextDim)
        Spacer(Modifier.width(VaultSpace.xs))
        FreshnessTag(state.worstStatus, state.worstUpdatedAt, state.now)
    }
}
