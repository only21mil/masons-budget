package com.sats21m.vogelvault.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

@Composable
internal fun LedgerAppearanceSettings(
    settings: LedgerUiSettings,
    onSettingsChange: (LedgerUiSettings) -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    Panel("Appearance") {
        Column(Modifier.padding(tokens.density.cardPadding)) {
            Text(
                "LEDGER TREATMENT",
                style = tokens.type.sectionLabel,
                color = tokens.colors.foregroundTertiary,
            )
            Row(
                Modifier.fillMaxWidth().padding(top = tokens.density.sectionLabelBottomSpace),
                horizontalArrangement = Arrangement.spacedBy(tokens.density.chipGap),
            ) {
                LedgerAppearance.entries.forEach { appearance ->
                    SelectionChip(
                        label = appearance.label,
                        semanticLabel = "${appearance.label} appearance",
                        actionLabel = "Use ${appearance.label.lowercase()} appearance",
                        selected = settings.appearance == appearance,
                        compact = true,
                        onSelect = { onSettingsChange(settings.copy(appearance = appearance)) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        HorizontalHairline()
        LedgerSettingToggle(
            label = "Scanlines",
            detail = "One-pixel ledger texture",
            checked = settings.scanlinesEnabled,
            onCheckedChange = { onSettingsChange(settings.copy(scanlinesEnabled = it)) },
        )
        HorizontalHairline()
        LedgerSettingToggle(
            label = "Phosphor glow",
            detail = "Subtle Bitcoin focus glow",
            checked = settings.phosphorGlowEnabled,
            onCheckedChange = { onSettingsChange(settings.copy(phosphorGlowEnabled = it)) },
        )
    }

    Panel("Behavior") {
        LedgerSettingToggle(
            label = "Reduce motion",
            detail = "Disables transitions and visual effects",
            checked = settings.reduceMotion,
            onCheckedChange = { onSettingsChange(settings.copy(reduceMotion = it)) },
        )
        HorizontalHairline()
        LedgerSettingToggle(
            label = "Reduce transparency",
            detail = "Disables scanlines and phosphor glow",
            checked = settings.reduceTransparency,
            onCheckedChange = { onSettingsChange(settings.copy(reduceTransparency = it)) },
        )
    }
}

@Composable
private fun LedgerSettingToggle(
    label: String,
    detail: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val tokens = LocalLedgerTheme.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = tokens.density.minimumHitTarget)
            .clickable(role = Role.Switch) { onCheckedChange(!checked) }
            .semantics { contentDescription = "$label, ${if (checked) "on" else "off"}" }
            .padding(horizontal = tokens.density.cardPadding, vertical = tokens.density.denseRowVerticalPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = tokens.type.rowPrimary, color = tokens.colors.foreground)
            Text(detail.uppercase(), style = tokens.type.rowMeta, color = tokens.colors.foregroundTertiary)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
