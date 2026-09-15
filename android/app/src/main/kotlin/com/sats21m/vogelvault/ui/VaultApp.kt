package com.sats21m.vogelvault.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
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
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
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
enum class Destination(val label: String) {
    HOME("Home"), BUDGET("Budget"), ACTIVITY("Activity"), BITCOIN("Bitcoin"),
    BTC_BUYS("BTC Buys"), BTC_BILL_PAYS("BTC Bill Pays"),
    EXPORT("Export"), TASKS("Tasks"),
    FAMILY("Family"), SETTINGS("Settings");
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

/** Fable glyph rail width on the inner display. */
const val RAIL_WIDTH_DP = 72
internal const val RAIL_ITEM_COUNT = 5

internal const val VAULT_RAIL_TEST_TAG = "vault-navigation-rail"
internal const val VAULT_RAIL_MORE_TEST_TAG = "vault-navigation-rail-more"
internal const val VAULT_SCREEN_CONTENT_TEST_TAG = "vault-screen-content"
internal const val VAULT_GEAR_MENU_TEST_TAG = "vault-gear-menu"

private val RAIL_EDGE_MARKER_WIDTH = 2.dp
private val RAIL_GLYPH_SIZE = 24.dp
private val RAIL_ITEM_HEIGHT = 48.dp
private val RAIL_GLYPH_INSET = 22.dp
private val RAIL_LABEL_GAP = 10.dp

internal val RAIL_PRIMARY_ORDER: List<Destination> = listOf(
    Destination.HOME, Destination.BUDGET, Destination.ACTIVITY,
    Destination.BITCOIN, Destination.TASKS,
)
internal fun railPrimaryDestinations(destinations: List<Destination>): List<Destination> =
    RAIL_PRIMARY_ORDER.filter { it in destinations }
internal fun railOverflowDestinations(destinations: List<Destination>): List<Destination> = emptyList()
internal fun foldedPrimaryDestinations(destinations: List<Destination>): List<Destination> =
    railPrimaryDestinations(destinations)
internal fun foldedOverflowDestinations(destinations: List<Destination>): List<Destination> = emptyList()

internal fun moreNavigationLabel(count: Int): String = "More ($count)"

internal fun ledgerNavigationSelectedTint(
    destination: Destination,
    colors: LedgerColors,
): Color = if (destination in setOf(Destination.BITCOIN, Destination.BTC_BUYS, Destination.BTC_BILL_PAYS)) colors.bitcoin else colors.foreground

internal fun ledgerNavigationUnselectedTint(colors: LedgerColors): Color = colors.foregroundSecondary

/**
 * @param onRequestProfileSwitchAuthentication the receiver that must authenticate
 * a profile switch before it happens. Null means the shell was composed without
 * one; the switch is then refused and named rather than silently dropped. A no-op
 * default here is what shipped, and it made the biometric gate unreachable.
 * @param profileSwitchRefusal the cause reported by that receiver, shown to the
 * user. A rejected switch names its cause.
 */
@OptIn(androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi::class)
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
    hingeOverride: LedgerHinge? = null,
    safeDrawingInsets: WindowInsets = WindowInsets.safeDrawing,
) {
    // An unwired shell refuses loudly instead of swallowing the request: the user
    // learns the switch did not happen, and so does anyone testing this screen.
    var unwiredRefusal by remember { mutableStateOf<ProfileSwitchRefusal?>(null) }
    val requestProfileSwitchAuthentication: (ProfileSwitchRequest) -> Unit =
        onRequestProfileSwitchAuthentication
            ?: { unwiredRefusal = ProfileSwitchRefusal.SHELL_NOT_CONNECTED }
    val refusal = unwiredRefusal ?: profileSwitchRefusal
    var routeParents by rememberSaveable(state.activeProfile) { mutableStateOf(emptyList<String>()) }
    var primaryReset by rememberSaveable(state.activeProfile) { mutableStateOf("") }
    val navigateWithin: (Destination) -> Unit = { target ->
        if (target != state.destination && target in destinationsFor(state.activeProfile)) {
            routeParents = routeParents + state.destination.name
            onNavigate(target)
        }
    }
    val navigatePrimary: (Destination) -> Unit = { target ->
        routeParents = emptyList()
        primaryReset = target.name + ":" + (primaryReset.substringAfter(":", "0").toInt() + 1)
        onNavigate(target)
    }
    val navigateBack: () -> Unit = {
        routeParents.lastOrNull()?.let { previous ->
            routeParents = routeParents.dropLast(1)
            onNavigate(Destination.valueOf(previous))
        }
    }
    BackHandler(routeParents.isNotEmpty(), onBack = navigateBack)
    val tokens = LocalLedgerTheme.current
    val observedHinge = rememberLedgerHinge()
    val density = LocalDensity.current
    var contentOrigin by remember { mutableStateOf(Offset.Zero) }
    BoxWithConstraints(modifier.fillMaxSize().background(tokens.colors.background)) {
        val widthClass = androidx.compose.material3.windowsizeclass.WindowSizeClass.calculateFromSize(
            androidx.compose.ui.unit.DpSize(maxWidth, maxHeight),
        ).widthSizeClass
        val expanded = widthClass != androidx.compose.material3.windowsizeclass.WindowWidthSizeClass.Compact
        val destinations = destinationsFor(state.activeProfile)
        val current = state.destination.takeIf { it in destinations } ?: Destination.HOME
        val selectedPrimary = routeParents.firstOrNull()?.let(Destination::valueOf) ?: current
        val hinge = hingeOverride ?: observedHinge
        val sheetRegion = ledgerSheetRegion(maxWidth, maxHeight, hinge)
        BoxWithConstraints(
            Modifier.fillMaxSize()
                .windowInsetsPadding(safeDrawingInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .onGloballyPositioned { contentOrigin = it.positionInWindow() },
        ) {
            // Measure the inset content and translate the window hinge to that same
            // origin. The rail and both panes now share the available width.
            val originX = with(density) { contentOrigin.x.toDp() }
            val originY = with(density) { contentOrigin.y.toDp() }
            val localHinge = hinge?.let {
                val origin = if (it.horizontal) originY else originX
                it.copy(start = it.start - origin, end = it.end - origin)
            }
            val plan = ledgerPanePlan(maxWidth, maxHeight, expanded, current in DETAIL_DESTINATIONS, localHinge)
                .copy(windowOriginY = originY)
            CompositionLocalProvider(
                LocalLedgerPanePlan provides plan,
                LocalLedgerSheetRegion provides sheetRegion,
                com.sats21m.vogelvault.ui.components.LocalLedgerRevealProfile provides state.activeProfile.key,
                com.sats21m.vogelvault.ui.components.LocalStateBlockRetry provides onWriteSucceeded,
                com.sats21m.vogelvault.ui.components.LocalFigureUnitCycle provides if (current.supportsFinancialDisplayUnit) ({
                    onDisplayUnitChange(DisplayUnit.entries[(displayUnit.ordinal + 1) % DisplayUnit.entries.size])
                }) else null,
            ) {
                // One call site owns ScreenHost in every posture. Resizing changes
                // constraints and chrome, never the composition that owns editors.
                Column(Modifier.fillMaxSize().padding(start = plan.leadingInset, top = plan.topInset)) {
                    Row(Modifier.weight(1f)) {
                        if (plan.railWidth > 0.dp) {
                            Box(Modifier.width(plan.railWidth).then(plan.listHeight?.let { Modifier.height(it) } ?: Modifier.fillMaxHeight())) {
                                VaultRail(destinations, selectedPrimary, navigatePrimary)
                            }
                        }
                        Column(Modifier.weight(1f)) {
                            Box(Modifier.width(plan.listWidth)) {
                                VaultTopBar(
                                    state,
                                    requestProfileSwitchAuthentication,
                                    onSwitchProfile,
                                    navigateWithin,
                                ) {
                                    onWriteSucceeded()
                                }
                            }
                            HorizontalHairline(Modifier.width(plan.listWidth))
                            VaultScreenContent(
                                state = state,
                                refusal = refusal,
                                profileSwitcher = {
                                    ProfileSwitcher(state.activeProfile, requestProfileSwitchAuthentication, onSwitchProfile)
                                },
                                current = current,
                                onNavigate = navigateWithin,
                                primaryReset = primaryReset,
                                onBack = navigateBack.takeIf { routeParents.isNotEmpty() },
                                onEnableRemoteRows = onEnableRemoteRows,
                                onRemoteRowsConnected = onRemoteRowsConnected,
                                onWriteSucceeded = onWriteSucceeded,
                                onStartRiverBillPay = onStartRiverBillPay,
                                displayUnit = displayUnit,
                                onDisplayUnitChange = onDisplayUnitChange,
                                ledgerSettings = ledgerSettings,
                                onLedgerSettingsChange = onLedgerSettingsChange,
                                modifier = Modifier.weight(1f).fillMaxWidth(),
                            )
                        }
                    }
                    if (plan.railWidth == 0.dp) {
                        HorizontalHairline(Modifier.width(plan.listWidth))
                        Box(Modifier.width(plan.listWidth)) { VaultBottomBar(destinations, selectedPrimary, navigatePrimary) }
                    }
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
    profileSwitcher: @Composable () -> Unit,
    current: Destination,
    onNavigate: (Destination) -> Unit,
    onBack: (() -> Unit)?,
    primaryReset: String,
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
    var quickAddRequested by rememberSaveable(state.activeProfile) { mutableStateOf(false) }
    val panePlan = LocalLedgerPanePlan.current
    val density = LocalDensity.current
    var contentOriginY by remember { mutableStateOf(0.dp) }
    BoxWithConstraints(modifier.onGloballyPositioned { coordinates ->
        contentOriginY = with(density) { coordinates.positionInWindow().y.toDp() }
    }) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.width(LocalLedgerPanePlan.current.listWidth)) {
                com.sats21m.vogelvault.ui.components.LedgerStatusLine(
                    shellConditions(state, refusal, onWriteSucceeded),
                )
            }
            // The cap goes on the screen, not the notices: a warning banner spans
            // the column, the ledger column does not.
            Box(Modifier.weight(1f).fillMaxWidth()) {
                CompositionLocalProvider(LocalLedgerListBottomClearance provides 80.dp) {
                ScreenHost(
                    destination = current,
                    quickAddRequested = quickAddRequested,
                    onQuickAddConsumed = { quickAddRequested = false },
                    state = state,
                    profileSwitcher = profileSwitcher,
                    onNavigate = onNavigate,
                    onBack = onBack,
                    primaryReset = primaryReset,
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
        }
        // The shell already applied the rail and leading/top insets. Keep the
        // button in the list pane, including the usable tabletop height.
        val fabHeight = (panePlan.listHeight?.let {
            it - (contentOriginY - panePlan.windowOriginY)
        } ?: maxHeight).coerceIn(0.dp, maxHeight)
        // Independently converted Dp bounds can differ at fractional densities
        // while laying out at the same physical pixel edge.
        val fabReachesBottom = with(density) { fabHeight.roundToPx() == maxHeight.roundToPx() }
        Box(Modifier.width(panePlan.listWidth.takeIf { it > 0.dp } ?: maxWidth)
            .height(fabHeight).align(Alignment.TopStart)
            // Folded content already ends above the inset-aware bottom bar.
            // A tabletop list ending above the hinge also needs no system inset.
            .then(if (panePlan.railWidth > 0.dp && fabReachesBottom) {
                Modifier.windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Bottom))
            } else Modifier)) {
            androidx.compose.material3.FloatingActionButton(
                onClick = { quickAddRequested = true },
                containerColor = LocalLedgerTheme.current.colors.bitcoinFill,
                contentColor = com.sats21m.vogelvault.ui.theme.LedgerPalettes.TerminalDark.background,
                modifier = Modifier.align(Alignment.BottomEnd).padding(VaultSpace.md).testTag("quick-add-fab"),
            ) { Text("+", modifier = Modifier.semantics { contentDescription = "Add transaction" }) }
        }
        LedgerAtmosphere()
    }
}

/** Refusals outrank read failures. Less urgent conditions remain available on expansion. */
@Composable
internal fun shellConditions(
    state: VaultUiState,
    refusal: ProfileSwitchRefusal?,
    onRetry: () -> Unit,
): List<com.sats21m.vogelvault.ui.components.LedgerCondition> {
    val conditions = mutableListOf<com.sats21m.vogelvault.ui.components.LedgerCondition>()
    refusal?.let {
        conditions += com.sats21m.vogelvault.ui.components.LedgerCondition(
            "profile-refusal", stringResource(it.titleRes), stringResource(it.detailRes), 100,
        )
    }
    if (state.staleAuthorization && state.primaryRowReadFailure == null) {
        conditions += com.sats21m.vogelvault.ui.components.LedgerCondition(
            "authorization", stringResource(R.string.convex_auth_error_title),
            stringResource(R.string.convex_auth_error_detail), 90, onRetry,
        )
    }
    val title = state.rowReadFailureTitleRes
    val detail = state.rowReadFailureDetailRes
    val projection = state.rowReadFailureProjectionRes
    if (title != null && detail != null && projection != null) {
        conditions += com.sats21m.vogelvault.ui.components.LedgerCondition(
            "row-read", stringResource(title), stringResource(detail, stringResource(projection)), 80, onRetry,
        )
    }
    if (!state.staleAuthorization && state.primaryRowReadFailure == null && state.worstStatus == Freshness.ERROR) {
        conditions += com.sats21m.vogelvault.ui.components.LedgerCondition(
            "refresh", stringResource(R.string.refresh_failed_title),
            stringResource(R.string.refresh_failed_detail), 70, onRetry,
        )
    }
    return conditions
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
    val currentIndex = primary.indexOf(current).let { if (it >= 0) it else primary.size }
    val railState = rememberLazyListState(initialFirstVisibleItemIndex = currentIndex)

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
            com.sats21m.vogelvault.ui.components.LedgerGlyphs.Horizon,
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

    }
}

@Composable
private fun VaultBottomBar(
    destinations: List<Destination>,
    current: Destination,
    onNavigate: (Destination) -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    BoxWithConstraints {
        val compactLabels = maxWidth < 360.dp
        LedgerTabBar(Modifier.windowInsetsPadding(WindowInsets.navigationBars)) {
            foldedPrimaryDestinations(destinations).forEach { destination ->
                LedgerTabItem(
                    glyph = destination.ledgerGlyph(),
                    label = destination.tabLabel(),
                    semanticLabel = destination.label,
                    selected = destination == current,
                    showLabel = !compactLabels || destination == current,
                    onClick = { onNavigate(destination) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun VaultTopBar(
    state: VaultUiState,
    onRequestProfileSwitchAuthentication: (ProfileSwitchRequest) -> Unit,
    onAuthorizedSwitch: (FamilyMember) -> Unit,
    onNavigate: (Destination) -> Unit,
    onRefresh: () -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    var gearExpanded by remember { mutableStateOf(false) }
    val gearDestinations = listOf(Destination.FAMILY, Destination.SETTINGS, Destination.EXPORT)
        .filter { it in destinationsFor(state.activeProfile) }
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
        if (gearDestinations.isNotEmpty()) {
            Box(Modifier.testTag(VAULT_GEAR_MENU_TEST_TAG)) {
                IconButton(onClick = { gearExpanded = true }) {
                    Icon(
                        com.sats21m.vogelvault.ui.components.LedgerGlyphs.Cog,
                        contentDescription = "More options",
                        tint = tokens.colors.foreground,
                    )
                }
                DropdownMenu(
                    expanded = gearExpanded,
                    onDismissRequest = { gearExpanded = false },
                ) {
                    gearDestinations.forEach { destination ->
                        LedgerMenuItem(
                            label = destination.label,
                            onClick = {
                                gearExpanded = false
                                onNavigate(destination)
                            },
                        )
                    }
                }
            }
        }
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
