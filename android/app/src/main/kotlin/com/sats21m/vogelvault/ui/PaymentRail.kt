package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.ui.components.LedgerGlyph
import com.sats21m.vogelvault.ui.components.LedgerGlyphRole
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme

internal const val PAYMENT_RAIL_TEST_TAG = "payment-rail"

internal enum class PaymentRailKind(val label: String, val glyph: ImageVector) {
    BOLT("Bolt", Icons.Filled.Bolt),
    CHAIN("Chain", Icons.Filled.Link),
}

/** A stored card wire decides the rail; display labels never do. */
internal fun paymentRailKind(cardWire: String?): PaymentRailKind? {
    val source = PaymentSource.fromWireOrNull(cardWire)
    return when {
        source == PaymentSource.ZEUS_LIGHTNING || source == PaymentSource.STRIKE -> PaymentRailKind.BOLT
        source?.route == PaymentSourceRoute.BITCOIN_TRANSACTION -> PaymentRailKind.CHAIN
        source?.route == PaymentSourceRoute.BILL_PAY -> PaymentRailKind.CHAIN
        PaymentSource.isRetiredTransactionWire(cardWire) ->
            if (cardWire == "lightning") PaymentRailKind.BOLT else PaymentRailKind.CHAIN
        else -> null
    }
}

@Composable
internal fun PaymentRail(source: PaymentSource, modifier: Modifier = Modifier) {
    val tokens = LocalLedgerTheme.current
    val kind = paymentRailKind(source.wire) ?: return
    Row(
        modifier = modifier
            .testTag(PAYMENT_RAIL_TEST_TAG)
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LedgerGlyph(
            imageVector = kind.glyph,
            role = LedgerGlyphRole.IMAGE,
            contentDescription = "${kind.label} payment rail",
            tint = tokens.colors.bitcoin,
        )
        Text(
            "${kind.label.uppercase()} · ${source.label.uppercase()}",
            style = tokens.type.rowMeta,
            color = tokens.colors.foregroundSecondary,
        )
    }
}
