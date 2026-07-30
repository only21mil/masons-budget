package com.sats21m.vogelvault.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ReadReadiness
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultBlack
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultWarning

internal fun requiresOnboarding(readiness: ReadReadiness): Boolean =
    readiness != ReadReadiness.READY

@Composable
internal fun OnboardingView(
    configurationError: String?,
    onConfigure: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Never save the plaintext credential in instance state.
    var readToken by remember { mutableStateOf("") }

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
        OutlinedTextField(
            value = readToken,
            onValueChange = { readToken = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.onboarding_token_label)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        Button(
            enabled = readToken.isNotBlank(),
            onClick = {
                onConfigure(readToken)
                readToken = ""
            },
        ) {
            Text(stringResource(R.string.onboarding_connect_action))
        }
    }
}
