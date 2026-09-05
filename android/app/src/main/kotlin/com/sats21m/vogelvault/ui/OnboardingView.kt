package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultWarning
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.components.Panel

internal enum class OnboardingStep(val title: String, val eyebrow: String, val detail: String) {
    WELCOME(
        title = "Connect Vogel Vault",
        eyebrow = "Sovereign ledger",
        detail = "Connect once to load household data securely on this device.",
    ),
    SCOPE(
        title = "Profiles stay scoped",
        eyebrow = "Household rules",
        detail = "Adults share household finances. Mason and Maddox remain isolated. Tasks stay private to the active profile.",
    ),
    CONNECT(
        title = "Pair this device",
        eyebrow = "Authenticated rows",
        detail = "Setup grants only the access approved for this installation. Credentials are never displayed or entered here.",
    ),
}

internal fun onboardingProgressLabel(index: Int): String =
    "Step ${index.coerceIn(0, OnboardingStep.entries.lastIndex) + 1} of ${OnboardingStep.entries.size}"

internal fun requiresOnboarding(remoteReadReady: Boolean): Boolean = !remoteReadReady

@Composable
internal fun OnboardingView(
    configurationError: String?,
    remoteReadReady: Boolean,
    onConnected: (BootstrapAccess) -> Unit,
    modifier: Modifier = Modifier,
) {
    var stepIndex by rememberSaveable { mutableIntStateOf(0) }
    val step = OnboardingStep.entries[stepIndex]
    val tokens = LocalLedgerTheme.current
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .background(tokens.colors.background)
                .padding(tokens.density.screenGutter),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.density.sectionTopSpace, Alignment.CenterVertically),
    ) {
        Icon(
            imageVector = Icons.Filled.AccountBalance,
            contentDescription = null,
            tint = tokens.colors.bitcoin,
        )
        Text(
            text = onboardingProgressLabel(stepIndex).uppercase(),
            style = tokens.type.screenSubtitle,
            color = tokens.colors.foregroundTertiary,
        )
        Panel {
            Column(
                Modifier.fillMaxWidth().padding(tokens.density.cardPadding),
                verticalArrangement = Arrangement.spacedBy(tokens.density.sectionLabelBottomSpace),
            ) {
                Text(step.eyebrow.uppercase(), style = tokens.type.sectionLabel, color = tokens.colors.bitcoin)
                Text(step.title, style = tokens.type.drilldownTitle, color = tokens.colors.foreground)
                Text(step.detail, style = tokens.type.body, color = tokens.colors.foregroundSecondary)
                if (step == OnboardingStep.CONNECT) {
                    configurationError?.let {
                        Text(it, style = tokens.type.body, color = tokens.colors.loss)
                    }
                    ReadBootstrapConfiguration(
                        remoteReadReady = remoteReadReady,
                        onConnected = onConnected,
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(
                enabled = stepIndex > 0,
                onClick = { stepIndex-- },
            ) { Text("Back") }
            if (stepIndex < OnboardingStep.entries.lastIndex) {
                VaultButton(label = "Next", onClick = { stepIndex++ })
            }
        }
    }
}
