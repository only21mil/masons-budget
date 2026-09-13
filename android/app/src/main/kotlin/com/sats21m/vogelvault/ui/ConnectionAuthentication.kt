package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.ContextWrapper

internal interface ConnectionAuthenticationHost {
    suspend fun authenticateConnectionChange(): Boolean
}

/** Connection changes use the activity's existing system prompt callback. */
internal suspend fun authenticateConnectionChange(context: Context): Boolean {
    val host = generateSequence(context) { (it as? ContextWrapper)?.baseContext }
        .filterIsInstance<ConnectionAuthenticationHost>().firstOrNull() ?: return false
    return host.authenticateConnectionChange()
}
