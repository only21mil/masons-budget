package com.sats21m.vogelvault

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as VaultApplication
        val loader = app.rowReadModelLoader()
        val remoteInitiallyEnabled = app.convexConfigSource.current().allowsRemoteRead
        setContent {
            VogelVaultTheme {
                val model: VaultViewModel = viewModel(
                    factory = VaultViewModel.factory(
                        loader = loader,
                        remoteInitiallyEnabled = remoteInitiallyEnabled,
                        enableRemote = app::enableRemoteRows,
                    ),
                )
                val state by model.state.collectAsStateWithLifecycle()
                VaultApp(
                    state = state,
                    onNavigate = model::navigate,
                    onSwitchProfile = model::switchProfile,
                    onEnableRemoteRows = model::enableRemoteRows,
                )
            }
        }
    }
}
