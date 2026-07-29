package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.CurrencyBitcoin
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.components.Badge
import com.sats21m.vogelvault.ui.components.FreshnessTag
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.StatusBanner
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
    BTC_BUYS("BTC Buys", Icons.Filled.CurrencyBitcoin),
    BTC_BILL_PAYS("BTC Bill Pays", Icons.Filled.ReceiptLong),
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

private const val FOLDED_MAX_ITEMS = 5
private const val FOLDED_PRIMARY_ITEMS_WITH_OVERFLOW = FOLDED_MAX_ITEMS - 1

internal fun foldedPrimaryDestinations(destinations: List<Destination>): List<Destination> =
    if (destinations.size <= FOLDED_MAX_ITEMS) {
        destinations
    } else {
        destinations.take(FOLDED_PRIMARY_ITEMS_WITH_OVERFLOW)
    }

internal fun foldedOverflowDestinations(destinations: List<Destination>): List<Destination> =
    if (destinations.size <= FOLDED_MAX_ITEMS) {
        emptyList()
    } else {
        destinations.drop(FOLDED_PRIMARY_ITEMS_WITH_OVERFLOW)
    }

@Composable
fun VaultApp(
    state: VaultUiState,
    onNavigate: (Destination) -> Unit,
    onSwitchProfile: (FamilyMember) -> Unit,
    onEnableRemoteRows: (String) -> Unit = {},
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    onDisplayUnitChange: (DisplayUnit) -> Unit = {},
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
                        VaultTopBar(state, onSwitchProfile) {
                            onSwitchProfile(state.activeProfile)
                        }
                        HorizontalHairline()
                        AuthorizationNotice(state)
                        RowReadFailureNotice(state)
                        RefreshFailureNotice(state)
                        ScreenHost(
                            current,
                            state,
                            onEnableRemoteRows,
                            displayUnit,
                            onDisplayUnitChange,
                            Modifier.weight(1f),
                        )
                    }
                }
            } else {
                Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    VaultTopBar(state, onSwitchProfile) {
                        onSwitchProfile(state.activeProfile)
                    }
                    HorizontalHairline()
                    AuthorizationNotice(state)
                    RowReadFailureNotice(state)
                    RefreshFailureNotice(state)
                    ScreenHost(
                        current,
                        state,
                        onEnableRemoteRows,
                        displayUnit,
                        onDisplayUnitChange,
                        Modifier.weight(1f),
                    )
                    HorizontalHairline()
                    VaultBottomBar(destinations, current, onNavigate)
                }
            }
        }
    }
}

@Composable
private fun AuthorizationNotice(state: VaultUiState) {
    if (!state.staleAuthorization || state.primaryRowReadFailure != null) return
    StatusBanner(
        text = stringResource(R.string.convex_auth_error_title),
        detail = stringResource(R.string.convex_auth_error_detail),
        tone = com.sats21m.vogelvault.ui.theme.VaultWarning,
    )
}

@Composable
private fun RowReadFailureNotice(state: VaultUiState) {
    val titleRes = state.rowReadFailureTitleRes ?: return
    val detailRes = state.rowReadFailureDetailRes ?: return
    StatusBanner(
        text = stringResource(titleRes),
        detail = stringResource(detailRes),
        tone = com.sats21m.vogelvault.ui.theme.VaultWarning,
    )
}

@Composable
private fun RefreshFailureNotice(state: VaultUiState) {
    if (
        state.staleAuthorization ||
        state.primaryRowReadFailure != null ||
        state.worstStatus != Freshness.ERROR
    ) {
        return
    }
    StatusBanner(
        text = stringResource(R.string.refresh_failed_title),
        detail = stringResource(R.string.refresh_failed_detail),
        tone = com.sats21m.vogelvault.ui.theme.VaultWarning,
    )
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
    val primary = foldedPrimaryDestinations(destinations)
    val overflow = foldedOverflowDestinations(destinations)
    var overflowExpanded by remember { mutableStateOf(false) }

    NavigationBar(containerColor = VaultSurfaceSunken) {
        primary.forEach { destination ->
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
        if (overflow.isNotEmpty()) {
            NavigationBarItem(
                selected = current in overflow,
                onClick = { overflowExpanded = true },
                icon = {
                    Box {
                        Icon(
                            Icons.Filled.MoreHoriz,
                            contentDescription = stringResource(R.string.navigation_more),
                        )
                        DropdownMenu(
                            expanded = overflowExpanded,
                            onDismissRequest = { overflowExpanded = false },
                            containerColor = VaultSurfaceSunken,
                        ) {
                            overflow.forEach { destination ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            destination.label,
                                            color = if (destination == current) {
                                                VaultCream
                                            } else {
                                                VaultTextDim
                                            },
                                        )
                                    },
                                    onClick = {
                                        overflowExpanded = false
                                        onNavigate(destination)
                                    },
                                    leadingIcon = {
                                        Icon(
                                            destination.icon,
                                            contentDescription = null,
                                            tint = if (destination == current) {
                                                VaultAccent
                                            } else {
                                                VaultTextMuted
                                            },
                                        )
                                    },
                                )
                            }
                        }
                    }
                },
                label = {
                    Text(
                        stringResource(R.string.navigation_more),
                        style = MaterialTheme.typography.labelSmall,
                    )
                },
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
private fun VaultTopBar(
    state: VaultUiState,
    onSwitchProfile: (FamilyMember) -> Unit,
    onRefresh: () -> Unit,
) {
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
            // A child has exactly one switch target — itself. Show a static label
            // rather than a control implying a door they cannot open.
            Badge("Child profile")
        } else {
            // Tappable, not decorative: these previously rendered as inert pills
            // that looked like tabs.
            state.switchTargets
                .filter { it != state.activeProfile }
                .forEach { target ->
                    Badge(target.displayName, onClick = { onSwitchProfile(target) })
                    Spacer(Modifier.width(VaultSpace.xs))
                }
        }
        Spacer(Modifier.weight(1f))
        if (state.worstStatus == Freshness.LOADING) {
            CircularProgressIndicator(
                modifier = Modifier.size(24.dp),
                color = VaultAccent,
                strokeWidth = 2.dp,
            )
        } else {
            IconButton(
                onClick = onRefresh,
                enabled = state.worstStatus != Freshness.DEMO,
            ) {
                Icon(
                    Icons.Filled.Refresh,
                    contentDescription = stringResource(
                        if (state.worstStatus == Freshness.DEMO) {
                            R.string.refresh_unavailable
                        } else {
                            R.string.refresh_data
                        },
                    ),
                    tint = if (state.worstStatus == Freshness.DEMO) VaultTextDim else VaultCream,
                )
            }
        }
        Spacer(Modifier.width(VaultSpace.xs))
        Text("SYNC", style = MaterialTheme.typography.labelSmall, color = VaultTextDim)
        Spacer(Modifier.width(VaultSpace.xs))
        FreshnessTag(state.worstStatus, state.worstUpdatedAt, state.now)
    }
}
