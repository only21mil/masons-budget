package com.sats21m.vogelvault.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultTextMuted

internal const val VAULT_SYNC_CONTROL_TEST_TAG = "vault-sync-control"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SyncControl(status: Freshness, updatedAt: Long?, now: Long, compact: Boolean, onRefresh: () -> Unit) {
    val tokens = LocalLedgerTheme.current
    val minutes = updatedAt?.let { ((now - it).coerceAtLeast(0) / 60_000).coerceAtMost(Int.MAX_VALUE.toLong()).toInt() }
    val (age, spokenAge) = when {
        minutes == null -> stringResource(R.string.sync_age_never) to stringResource(R.string.sync_age_never)
        minutes < 1 -> stringResource(R.string.sync_age_now) to stringResource(R.string.sync_age_just_now)
        minutes < 60 -> stringResource(R.string.sync_age_minutes, minutes) to pluralStringResource(R.plurals.sync_minutes_ago, minutes, minutes)
        minutes < 1440 -> stringResource(R.string.sync_age_hours, minutes / 60) to pluralStringResource(R.plurals.sync_hours_ago, minutes / 60, minutes / 60)
        else -> stringResource(R.string.sync_age_days, minutes / 1440) to pluralStringResource(R.plurals.sync_days_ago, minutes / 1440, minutes / 1440)
    }
    val description = when (status) {
        Freshness.LOADING -> stringResource(R.string.sync_loading)
        Freshness.ERROR -> stringResource(R.string.sync_failed_retry)
        Freshness.DEMO -> stringResource(R.string.sync_demo_unavailable)
        Freshness.STALE -> stringResource(R.string.sync_stale_refresh, spokenAge)
        else -> stringResource(R.string.sync_refresh, spokenAge)
    }
    val label = when (status) {
        Freshness.ERROR -> stringResource(R.string.sync_error_label)
        Freshness.DEMO -> stringResource(R.string.sync_demo_label)
        else -> age
    }
    val dot = when (status) {
        Freshness.LIVE -> ledgerColor(VaultPositive)
        Freshness.STALE -> tokens.colors.bitcoin
        Freshness.ERROR -> ledgerColor(VaultNegative)
        Freshness.LOADING -> ledgerColor(VaultInfo)
        else -> ledgerColor(VaultTextMuted)
    }
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(description) } },
        state = rememberTooltipState(),
    ) {
        Row(
            Modifier.testTag(VAULT_SYNC_CONTROL_TEST_TAG)
                .alpha(if (status == Freshness.DEMO) 0.38f else 1f)
                .clickable(enabled = status != Freshness.DEMO && status != Freshness.LOADING, role = Role.Button, onClick = onRefresh)
                .semantics(mergeDescendants = true) { contentDescription = description }
                .sizeIn(minWidth = 48.dp, minHeight = 48.dp, maxWidth = if (compact) 48.dp else 112.dp)
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!compact) Text(label, style = tokens.type.chip,
                color = if (status == Freshness.STALE) tokens.colors.bitcoin else tokens.colors.foreground,
                maxLines = 1, modifier = Modifier.weight(1f, fill = false))
            Box(Modifier.size(24.dp)) {
                if (status == Freshness.LOADING) {
                    CircularProgressIndicator(Modifier.size(24.dp), color = tokens.colors.bitcoin, strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Filled.Refresh, contentDescription = null, tint = tokens.colors.foreground, modifier = Modifier.size(24.dp))
                    if (status != Freshness.DEMO) LedgerStatusDot(dot, Modifier.align(Alignment.TopEnd))
                }
            }
        }
    }
}
