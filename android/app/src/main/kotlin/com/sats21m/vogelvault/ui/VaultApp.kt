package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.CurrencyBitcoin
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Savings
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.components.Badge
import com.sats21m.vogelvault.ui.components.FreshnessTag
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.LedgerGlyphs
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.components.VerticalHairline
import com.sats21m.vogelvault.ui.theme.LocalIsUnfolded
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.LedgerColors
import com.sats21m.vogelvault.ui.theme.VaultBitcoin
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultNavSlate
import com.sats21m.vogelvault.ui.theme.VaultSpace

/**
 * Destinations.
 *
 * Every destination has a child-scoped presentation. Privacy is enforced where
 * each screen receives or derives its collections; the destination catalog is
 * not an authorization boundary.
 */
enum class Destination(
    val label: String,
    val icon: ImageVector,
    /**
     * Resting glyph colour. Navigation item colors consume this value so their
     * selected colors remain authoritative; never pass it directly to Icon.
     */
    val navigationRestingTint: Color,
) {
    DASHBOARD("Dashboard", Icons.Filled.Dashboard, VaultNavSlate),
    ACTIVITY("Activity", Icons.AutoMirrored.Filled.ReceiptLong, VaultNavSlate),
    BUDGET("Budget", Icons.Filled.Payments, VaultNavSlate),
    BITCOIN("Bitcoin", Icons.Filled.CurrencyBitcoin, VaultBitcoin),
    BTC_BUYS("BTC Buys", Icons.Filled.CurrencyBitcoin, VaultBitcoin),
    BTC_BILL_PAYS("BTC Bill Pays", Icons.AutoMirrored.Filled.ReceiptLong, VaultBitcoin),
    NET_WORTH("Net Worth", Icons.Filled.AccountBalance, VaultNavSlate),
    RETIREMENT("Retirement", Icons.Filled.Savings, VaultNavSlate),
    EXPORT("Export", Icons.Filled.FileDownload, VaultNavSlate),
    TODAY("Today", Icons.Filled.WbSunny, VaultNavSlate),
    TASKS("Tasks", Icons.Filled.Checklist, VaultNavSlate),
    FAMILY("Family", Icons.Filled.People, VaultNavSlate),
    SETTINGS("Settings", Icons.Filled.Settings, VaultNavSlate);

    val navigationSelectedTint: Color
        get() = if (navigationRestingTint == VaultBitcoin) VaultBitcoin else VaultCream
}

/**
 * The unfolded threshold.
 *
 * A Pixel Fold is ~840dp wide unfolded and ~370dp folded, so 600dp cleanly
 * separates the two without depending on a hinge API. Named rather than inlined
 * so the screenshot tests assert against the same number the UI uses.
 */
const val UNFOLDED_MIN_WIDTH_DP = 600

/**
 * The unfolded content cap.
 *
 * Beside the rail, a screen without a sidebar keeps its column at this width and
 * leaves the rest as ground. A ledger row stretched across 1500px puts the figure
 * too far from its label to read as one line.
 */
const val UNFOLDED_CONTENT_MAX_WIDTH_DP = 560

/** The handoff rail: 130dp, seven destinations, a 2dp edge marker on the active one. */
const val RAIL_WIDTH_DP = 130
internal const val RAIL_ITEM_COUNT = 7

private const val FOLDED_MAX_ITEMS = 5
private const val FOLDED_PRIMARY_ITEMS_WITH_OVERFLOW = FOLDED_MAX_ITEMS - 1
internal const val VAULT_RAIL_TEST_TAG = "vault-navigation-rail"
internal const val VAULT_RAIL_MORE_TEST_TAG = "vault-navigation-rail-more"
internal const val VAULT_SCREEN_CONTENT_TEST_TAG = "vault-screen-content"

private val RAIL_EDGE_MARKER_WIDTH = 2.dp
private val RAIL_GLYPH_SIZE = 24.dp
private val RAIL_ITEM_HEIGHT = 48.dp
private val RAIL_GLYPH_INSET = 14.dp
private val RAIL_LABEL_GAP = 10.dp

/**
 * The six destinations the rail shows directly, in handoff order. Everything
 * else lives under More, which is the seventh item.
 */
internal val RAIL_PRIMARY_ORDER: List<Destination> = listOf(
    Destination.DASHBOARD,
    Destination.ACTIVITY,
    Destination.BUDGET,
    Destination.BITCOIN,
    Destination.TODAY,
    Destination.TASKS,
)

internal fun railPrimaryDestinations(destinations: List<Destination>): List<Destination> =
    RAIL_PRIMARY_ORDER.filter { it in destinations }

internal fun railOverflowDestinations(destinations: List<Destination>): List<Destination> =
    destinations.filterNot { it in RAIL_PRIMARY_ORDER }

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

internal fun moreNavigationLabel(count: Int): String = "More ($count)"

internal fun ledgerNavigationSelectedTint(
    destination: Destination,
    colors: LedgerColors,
): Color = if (destination.navigationRestingTint == VaultBitcoin) colors.bitcoin else colors.foreground

internal fun ledgerNavigationUnselectedTint(colors: LedgerColors): Color = colors.foregroundSecondary

/**
 * @param onRequestProfileSwitchAuthentication the receiver that must authenticate
 * a profile switch before it happens. Null means the shell was composed without
 * one; the switch is then refused and named rather than silently dropped. A no-op
 * default here is what shipped, and it made the biometric gate unreachable.
 * @param profileSwitchRefusal the cause reported by that receiver, shown to the
 * user. A rejected switch names its cause.
 */
@Composable
fun VaultApp(
    state: VaultUiState,
    onNavigate: (Destination) -> Unit,
    onSwitchProfile: (FamilyMember) -> Unit,
    onRequestProfileSwitchAuthentication: ((ProfileSwitchRequest) -> Unit)? = null,
    profileSwitchRefusal: ProfileSwitchRefusal? = null,
    onEnableRemoteRows: (String) -> Unit = {},
    onRemoteRowsConnected: () -> Unit = {},
    onWriteSucceeded: () -> Unit = {},
    onStartRiverBillPay: (BillPayPrefill) -> Unit = {},
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    onDisplayUnitChange: (DisplayUnit) -> Unit = {},
    ledgerSettings: LedgerUiSettings = LedgerUiSettings(),
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    // An unwired shell refuses loudly instead of swallowing the request: the user
    // learns the switch did not happen, and so does anyone testing this screen.
    var unwiredRefusal by remember { mutableStateOf<ProfileSwitchRefusal?>(null) }
    val requestProfileSwitchAuthentication: (ProfileSwitchRequest) -> Unit =
        onRequestProfileSwitchAuthentication
            ?: { unwiredRefusal = ProfileSwitchRefusal.SHELL_NOT_CONNECTED }
    val refusal = unwiredRefusal ?: profileSwitchRefusal
    val tokens = LocalLedgerTheme.current
    BoxWithConstraints(modifier.fillMaxSize().background(tokens.colors.background)) {
        val unfolded = maxWidth.value >= UNFOLDED_MIN_WIDTH_DP

        CompositionLocalProvider(LocalIsUnfolded provides unfolded) {
            val destinations = destinationsFor(state.activeProfile)
            val current = state.destination.takeIf { it in destinations } ?: Destination.DASHBOARD

            if (unfolded) {
                Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    VaultRail(destinations, current, onNavigate)
                    VerticalHairline(Modifier.fillMaxHeight())
                    Column(Modifier.weight(1f)) {
                        VaultTopBar(state, requestProfileSwitchAuthentication, onSwitchProfile) {
                            onWriteSucceeded()
                        }
                        HorizontalHairline()
                        Row(Modifier.weight(1f)) {
                            VaultScreenContent(
                                state = state,
                                refusal = refusal,
                                current = current,
                                onEnableRemoteRows = onEnableRemoteRows,
                                onRemoteRowsConnected = onRemoteRowsConnected,
                                onWriteSucceeded = onWriteSucceeded,
                                onStartRiverBillPay = onStartRiverBillPay,
                                displayUnit = displayUnit,
                                onDisplayUnitChange = onDisplayUnitChange,
                                ledgerSettings = ledgerSettings,
                                onLedgerSettingsChange = onLedgerSettingsChange,
                                contentMaxWidth = UNFOLDED_CONTENT_MAX_WIDTH_DP.dp,
                                modifier = Modifier.weight(1f).fillMaxHeight(),
                            )
                            if (showsLedgerSidebar(current, unfolded)) {
                                VerticalHairline(Modifier.fillMaxHeight())
                                LedgerSidebar(state = state, displayUnit = displayUnit)
                            }
                        }
                    }
                }
            } else {
                Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    VaultTopBar(state, requestProfileSwitchAuthentication, onSwitchProfile) {
                        onWriteSucceeded()
                    }
                    HorizontalHairline()
                    VaultScreenContent(
                        state = state,
                        refusal = refusal,
                        current = current,
                        onEnableRemoteRows = onEnableRemoteRows,
                        onRemoteRowsConnected = onRemoteRowsConnected,
                        onWriteSucceeded = onWriteSucceeded,
                        onStartRiverBillPay = onStartRiverBillPay,
                        displayUnit = displayUnit,
                        onDisplayUnitChange = onDisplayUnitChange,
                        ledgerSettings = ledgerSettings,
                        onLedgerSettingsChange = onLedgerSettingsChange,
                        modifier = Modifier.weight(1f),
                    )
                    HorizontalHairline()
                    VaultBottomBar(destinations, current, onNavigate)
                }
            }
        }
    }
}

/**
 * The posture-independent body shared by the unfolded and folded shells: the
 * four notice banners above the active screen, with the ledger atmosphere
 * drawn behind both. The branches differ only by navigation chrome.
 */
@Composable
private fun VaultScreenContent(
    state: VaultUiState,
    refusal: ProfileSwitchRefusal?,
    current: Destination,
    onEnableRemoteRows: (String) -> Unit,
    onRemoteRowsConnected: () -> Unit,
    onWriteSucceeded: () -> Unit,
    onStartRiverBillPay: (BillPayPrefill) -> Unit,
    displayUnit: DisplayUnit,
    onDisplayUnitChange: (DisplayUnit) -> Unit,
    ledgerSettings: LedgerUiSettings,
    onLedgerSettingsChange: (LedgerUiSettings) -> Unit,
    modifier: Modifier = Modifier,
    /** Null lets the screen fill its column; folded screens do. */
    contentMaxWidth: Dp? = null,
) {
    Box(modifier) {
        Column(Modifier.fillMaxSize()) {
            ProfileSwitchRefusalNotice(refusal)
            AuthorizationNotice(state)
            RowReadFailureNotice(state, onWriteSucceeded)
            RefreshFailureNotice(state, onWriteSucceeded)
            // The cap goes on the screen, not the notices: a warning banner spans
            // the column, the ledger column does not.
            Box(Modifier.weight(1f).fillMaxWidth()) {
                ScreenHost(
                    destination = current,
                    state = state,
                    onEnableRemoteRows = onEnableRemoteRows,
                    onRemoteRowsConnected = onRemoteRowsConnected,
                    onWriteSucceeded = onWriteSucceeded,
                    onStartRiverBillPay = onStartRiverBillPay,
                    displayUnit = displayUnit,
                    onDisplayUnitChange = onDisplayUnitChange,
                    ledgerSettings = ledgerSettings,
                    onLedgerSettingsChange = onLedgerSettingsChange,
                    modifier = Modifier
                        .fillMaxHeight()
                        .then(if (contentMaxWidth != null) Modifier.widthIn(max = contentMaxWidth) else Modifier)
                        .testTag(VAULT_SCREEN_CONTENT_TEST_TAG),
                )
            }
        }
        LedgerAtmosphere()
    }
}

/**
 * Why the profile did not change.
 *
 * Rendered above every other notice and never suppressed by one: the user just
 * asked for this, and a refusal they cannot see is the silent failure the house
 * rules forbid.
 */
@Composable
private fun ProfileSwitchRefusalNotice(refusal: ProfileSwitchRefusal?) {
    if (refusal == null) return
    StatusBanner(
        text = stringResource(refusal.titleRes),
        detail = stringResource(refusal.detailRes),
        tone = com.sats21m.vogelvault.ui.theme.VaultWarning,
    )
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
private fun RowReadFailureNotice(state: VaultUiState, onRetry: () -> Unit) {
    val titleRes = state.rowReadFailureTitleRes ?: return
    val detailRes = state.rowReadFailureDetailRes ?: return
    val projectionRes = state.rowReadFailureProjectionRes ?: return
    StatusBanner(
        text = stringResource(titleRes),
        detail = stringResource(detailRes, stringResource(projectionRes)),
        tone = com.sats21m.vogelvault.ui.theme.VaultWarning,
    )
    TextButton(onClick = onRetry) { Text("Retry") }
}

@Composable
private fun RefreshFailureNotice(state: VaultUiState, onRetry: () -> Unit) {
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
    TextButton(onClick = onRetry) { Text("Retry") }
}

/**
 * The unfolded rail.
 *
 * 130dp, the six primary destinations plus More, glyph and uppercase label side
 * by side. The active item is bitcoin ink with a 2dp bitcoin edge marker on the
 * left and the soft bitcoin fill behind it; inactive items are tertiary ink. No
 * pill: nothing in this system is fully rounded except the toggle track and the
 * status dots. The list still scrolls so a large-font setting cannot hide More.
 */
@Composable
private fun VaultRail(
    destinations: List<Destination>,
    current: Destination,
    onNavigate: (Destination) -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    val primary = railPrimaryDestinations(destinations)
    val overflow = railOverflowDestinations(destinations)
    val currentIndex = primary.indexOf(current).let { if (it >= 0) it else primary.size }
    val railState = rememberLazyListState(initialFirstVisibleItemIndex = currentIndex)
    var overflowExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(currentIndex) {
        if (railState.layoutInfo.visibleItemsInfo.none { it.index == currentIndex }) {
            railState.scrollToItem(currentIndex)
        }
    }

    Column(
        Modifier
            .fillMaxHeight()
            .width(RAIL_WIDTH_DP.dp)
            .background(tokens.colors.panel),
    ) {
        Spacer(Modifier.height(VaultSpace.lg))
        Icon(
            Icons.Filled.AccountBalance,
            contentDescription = null,
            tint = tokens.colors.bitcoin,
            modifier = Modifier
                .padding(start = RAIL_EDGE_MARKER_WIDTH + RAIL_GLYPH_INSET)
                .size(RAIL_GLYPH_SIZE),
        )
        Spacer(Modifier.height(VaultSpace.lg))
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .testTag(VAULT_RAIL_TEST_TAG),
            state = railState,
        ) {
            items(
                count = primary.size,
                key = { index -> primary[index].name },
            ) { index ->
                val destination = primary[index]
                RailItem(
                    icon = destination.ledgerGlyph(),
                    label = destination.label,
                    selected = destination == current,
                    onClick = { onNavigate(destination) },
                )
            }
            if (overflow.isNotEmpty()) {
                item(key = "more") {
                    Box {
                        RailItem(
                            icon = LedgerGlyphs.Dots,
                            label = moreNavigationLabel(overflow.size),
                            selected = current in overflow,
                            onClick = { overflowExpanded = true },
                            modifier = Modifier.testTag(VAULT_RAIL_MORE_TEST_TAG),
                        )
                        DropdownMenu(
                            expanded = overflowExpanded,
                            onDismissRequest = { overflowExpanded = false },
                            containerColor = tokens.colors.panel,
                        ) {
                            overflow.forEach { destination ->
                                val ink = if (destination == current) {
                                    tokens.colors.bitcoin
                                } else {
                                    tokens.colors.foregroundSecondary
                                }
                                DropdownMenuItem(
                                    text = { Text(destination.label, color = ink) },
                                    onClick = {
                                        overflowExpanded = false
                                        onNavigate(destination)
                                    },
                                    leadingIcon = {
                                        Icon(
                                            destination.ledgerGlyph(),
                                            contentDescription = null,
                                            modifier = Modifier.size(18.dp),
                                            tint = ink,
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RailItem(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalLedgerTheme.current
    val ink = if (selected) tokens.colors.bitcoin else tokens.colors.foregroundTertiary
    Row(
        modifier
            .fillMaxWidth()
            .height(RAIL_ITEM_HEIGHT)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .background(if (selected) tokens.colors.bitcoinSoft else Color.Transparent),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(RAIL_EDGE_MARKER_WIDTH)
                .fillMaxHeight()
                .background(if (selected) tokens.colors.bitcoin else Color.Transparent),
        )
        Spacer(Modifier.width(RAIL_GLYPH_INSET))
        Icon(icon, contentDescription = label, tint = ink, modifier = Modifier.size(RAIL_GLYPH_SIZE))
        Spacer(Modifier.width(RAIL_LABEL_GAP))
        Text(
            label.uppercase(),
            style = tokens.type.tabLabel,
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(end = VaultSpace.sm),
        )
    }
}

@Composable
private fun VaultBottomBar(
    destinations: List<Destination>,
    current: Destination,
    onNavigate: (Destination) -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    val unselectedTint = ledgerNavigationUnselectedTint(tokens.colors)
    val primary = foldedPrimaryDestinations(destinations)
    val overflow = foldedOverflowDestinations(destinations)
    var overflowExpanded by remember { mutableStateOf(false) }

    LedgerTabBar {
        primary.forEach { destination ->
            LedgerTabItem(
                glyph = destination.ledgerGlyph(),
                label = destination.tabLabel(),
                semanticLabel = destination.label,
                selected = destination == current,
                onClick = { onNavigate(destination) },
                modifier = Modifier.weight(1f),
            )
        }
        if (overflow.isNotEmpty()) {
            Box(Modifier.weight(1f)) {
                LedgerTabItem(
                    glyph = LedgerGlyphs.Dots,
                    label = stringResource(R.string.navigation_more),
                    semanticLabel = moreNavigationLabel(overflow.size),
                    selected = current in overflow,
                    onClick = { overflowExpanded = true },
                    modifier = Modifier.fillMaxWidth(),
                )
                DropdownMenu(
                    expanded = overflowExpanded,
                    onDismissRequest = { overflowExpanded = false },
                    containerColor = tokens.colors.panel,
                ) {
                    overflow.forEach { destination ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    destination.label,
                                    style = tokens.type.rowPrimary,
                                    color = if (destination == current) {
                                        tokens.colors.foreground
                                    } else {
                                        unselectedTint
                                    },
                                )
                            },
                            onClick = {
                                overflowExpanded = false
                                onNavigate(destination)
                            },
                            leadingIcon = {
                                Icon(
                                    destination.ledgerGlyph(),
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                    tint = if (destination == current) tokens.colors.bitcoin else unselectedTint,
                                )
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun VaultTopBar(
    state: VaultUiState,
    onRequestProfileSwitchAuthentication: (ProfileSwitchRequest) -> Unit,
    onAuthorizedSwitch: (FamilyMember) -> Unit,
    onRefresh: () -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    Row(
        Modifier
            .fillMaxWidth()
            .background(tokens.colors.panel)
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProfileSwitcher(
            activeProfile = state.activeProfile,
            onAuthenticationRequired = onRequestProfileSwitchAuthentication,
            onAuthorizedSwitch = onAuthorizedSwitch,
        )
        Spacer(Modifier.weight(1f))
        if (state.worstStatus == Freshness.LOADING) {
            CircularProgressIndicator(
                modifier = Modifier.size(24.dp),
                color = tokens.colors.bitcoin,
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
                    tint = if (state.worstStatus == Freshness.DEMO) tokens.colors.foregroundTertiary else tokens.colors.foreground,
                )
            }
        }
        Spacer(Modifier.width(VaultSpace.xs))
        Text("SYNC", style = tokens.type.tabLabel, color = tokens.colors.foregroundTertiary)
        Spacer(Modifier.width(VaultSpace.xs))
        FreshnessTag(state.worstStatus, state.worstUpdatedAt, state.now)
    }
}

internal fun destinationsFor(profile: FamilyMember): List<Destination> =
    Destination.entries.filter { profile.isAdult || it !in setOf(Destination.SETTINGS, Destination.EXPORT, Destination.FAMILY) }
