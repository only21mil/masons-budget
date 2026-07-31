package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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

internal fun requiresOnboarding(remoteReadReady: Boolean): Boolean = !remoteReadReady

@Composable
internal fun OnboardingView(
    configurationError: String?,
    remoteReadReady: Boolean,
    onConnected: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .background(VaultBlack)
                .padding(VaultSpace.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(VaultSpace.md, Alignment.CenterVertically),
    ) {
        Icon(
            imageVector = Icons.Filled.AccountBalance,
            contentDescription = null,
            tint = VaultAccent,
        )
        Text(
            text = stringResource(R.string.onboarding_title),
            style = MaterialTheme.typography.headlineSmall,
            color = VaultCream,
        )
        Text(
            text = stringResource(R.string.onboarding_detail),
            style = MaterialTheme.typography.bodyMedium,
            color = VaultTextDim,
        )
        Text(
            text = stringResource(R.string.onboarding_token_help),
            style = MaterialTheme.typography.bodySmall,
            color = VaultTextDim,
        )
        configurationError?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodySmall,
                color = VaultWarning,
            )
        }
        ReadBootstrapConfiguration(
            remoteReadReady = remoteReadReady,
            onConnected = onConnected,
        )
    }
}
