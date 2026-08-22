package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultAccentDim
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultLine
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted

@Composable
internal fun HorizonSelector(
    options: List<Int>,
    selected: Int,
    onSelect: (Int) -> Unit,
) {
    require(options.isNotEmpty())
    require(selected in options)
    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
        Text(
            stringResource(R.string.horizon_label),
            style = MaterialTheme.typography.labelSmall,
            color = VaultTextDim,
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            options.forEach { years ->
                SelectionChip(
                    label = stringResource(R.string.horizon_years, years),
                    semanticLabel = stringResource(R.string.horizon_years, years),
                    actionLabel = stringResource(R.string.horizon_action, years),
                    selected = years == selected,
                    onSelect = { onSelect(years) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * Ledger choice-chip language shared by month, horizon, and display-unit pickers.
 * Orange marks selection only in the border and fill. Text stays cream or muted.
 */
@Composable
internal fun SelectionChip(
    label: String,
    semanticLabel: String,
    actionLabel: String,
    selected: Boolean,
    compact: Boolean = false,
    modifier: Modifier = Modifier,
    onSelect: () -> Unit,
) {
    val shape = RoundedCornerShape(99.dp)
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
            .semantics {
                contentDescription = semanticLabel
                stateDescription = if (selected) "Selected" else "Not selected"
                onClick(label = actionLabel) {
                    onSelect()
                    true
                }
            }
            .background(if (selected) VaultAccentDim else VaultSurface, shape)
            .border(1.dp, if (selected) VaultAccent.copy(alpha = 0.42f) else VaultLine, shape)
            .padding(
                horizontal = if (compact) VaultSpace.sm else VaultSpace.md,
                vertical = if (compact) VaultSpace.xs else VaultSpace.sm,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = if (selected) VaultCream else VaultTextMuted,
            maxLines = 1,
        )
    }
}