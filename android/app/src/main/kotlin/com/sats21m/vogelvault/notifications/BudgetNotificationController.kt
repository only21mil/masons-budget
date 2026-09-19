package com.sats21m.vogelvault.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.sats21m.vogelvault.MainActivity
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.VaultUiState

class BudgetNotificationController(context: Context) {
    private val appContext = context.applicationContext
    private val preferences =
        appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val dispatcher =
        BudgetNotificationDispatcher(
            evaluator = BudgetNotificationEvaluator(),
            deduplicator = SharedPreferencesBudgetAlertDeduplicator(preferences),
            publisher = AndroidBudgetAlertPublisher(appContext),
        )

    fun isEnabled(profile: FamilyMember): Boolean =
        preferences.getBoolean(enabledKey(profile), false)

    fun setEnabled(profile: FamilyMember, enabled: Boolean) {
        preferences.edit().putBoolean(enabledKey(profile), enabled).apply()
        if (!enabled) cancelVisibleAlerts()
    }

    fun evaluateAndNotify(state: VaultUiState) {
        dispatcher.dispatch(state, enabled = isEnabled(state.activeProfile))
    }

    /** Removes budget amounts from the notification shade when privacy closes. */
    fun cancelVisibleAlerts() {
        AndroidBudgetAlertPublisher.cancelVisibleAlerts(appContext)
    }

    private fun enabledKey(profile: FamilyMember): String =
        "$ENABLED_PREFIX${profile.notificationScopeKey}"

    private val FamilyMember.notificationScopeKey: String
        get() = if (isAdult) ADULT_HOUSEHOLD_SCOPE else key

    private companion object {
        const val PREFERENCES_NAME = "budget_notifications"
        const val ENABLED_PREFIX = "enabled:"
        const val ADULT_HOUSEHOLD_SCOPE = "adult-household"
    }
}

private class SharedPreferencesBudgetAlertDeduplicator(
    private val preferences: android.content.SharedPreferences,
) : BudgetAlertDeduplicator {
    override fun wasSent(key: String): Boolean =
        preferences.getBoolean("$SENT_PREFIX$key", false)

    override fun markSent(key: String) {
        preferences.edit().putBoolean("$SENT_PREFIX$key", true).apply()
    }

    private companion object {
        const val SENT_PREFIX = "sent:"
    }
}

internal class AndroidBudgetAlertPublisher(
    private val context: Context,
) : BudgetAlertPublisher {
    private val notificationManager =
        context.getSystemService(NotificationManager::class.java)

    override fun canPublish(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

    override fun publish(alert: BudgetAlert) {
        createChannel()
        val openApp =
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val title =
            context.getString(
                when (alert.level) {
                    BudgetAlertLevel.NEARING_LIMIT -> R.string.budget_notification_nearing_title
                    BudgetAlertLevel.OVER_LIMIT -> R.string.budget_notification_over_title
                },
                alert.category,
            )
        val body =
            context.getString(
                R.string.budget_notification_body,
                Money.formatUsd(alert.spentCents),
                Money.formatUsd(alert.budgetCents),
                alert.month,
            )
        val notification =
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                // The body carries exact spent/budget USD amounts. SECRET hides
                // every bit of it from the lock screen, closing the residual
                // window between screen-off and onStop's cancelVisibleAlerts();
                // the in-app shade is unaffected.
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setContentIntent(openApp)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()

        // The tag carries the full collision-free dedupe key. The integer ID is
        // intentionally constant because Android identifies this overload by
        // the tag/ID pair.
        notificationManager.notify(alert.deduplicationKey, NOTIFICATION_ID, notification)
    }

    private fun createChannel() {
        notificationManager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.budget_notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.budget_notification_channel_description)
            },
        )
    }

    companion object {
        const val CHANNEL_ID = "budget_alerts"
        const val NOTIFICATION_ID = 1

        fun cancelVisibleAlerts(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.activeNotifications
                .filter { it.notification.channelId == CHANNEL_ID }
                .forEach { manager.cancel(it.tag, it.id) }
        }
    }
}
