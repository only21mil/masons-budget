package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.SharedPreferences

/**
 * User-facing payment sources in the canonical shared-fixture order.
 *
 * [wire] is the durable selector identity and the transaction card value. [label]
 * is display-only and must never cross the mutation boundary.
 */
internal enum class PaymentSource(
    val wire: String,
    val label: String,
    val route: PaymentSourceRoute,
) {
    RIVER(
        wire = "river",
        label = "River",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    ZEUS_LIGHTNING(
        wire = "zeus_lightning",
        label = "Zeus Lightning",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    ZEUS_ON_CHAIN(
        wire = "zeus_on_chain",
        label = "Zeus On-chain",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    STRIKE(
        wire = "strike",
        label = "Strike",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    COINBASE_CARD(
        wire = "coinbase_card",
        label = "Coinbase Card",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    AVEN(
        wire = "aven",
        label = "Aven",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    SOFI_CARD(
        wire = "sofi_card",
        label = "SoFi Card",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    CAPITAL_ONE_VX(
        wire = "capital_one_vx",
        label = "Capital One VX",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    RIVER_BITCOIN_BILL_PAY(
        wire = "river_bitcoin_bill_pay",
        label = "River Bitcoin Bill Pay",
        route = PaymentSourceRoute.BILL_PAY,
    );

    val isBitcoinTransaction: Boolean
        get() = route == PaymentSourceRoute.BITCOIN_TRANSACTION

    companion object {
        val DEFAULT: PaymentSource = COINBASE_CARD

        private val RETIRED_TRANSACTION_WIRES = setOf("lightning", "on_chain", "on-chain")

        fun fromWireOrNull(wire: String?): PaymentSource? =
            entries.firstOrNull { it.wire == wire }

        fun fromWireOrDefault(wire: String?): PaymentSource =
            fromWireOrNull(wire) ?: DEFAULT

        fun isRetiredTransactionWire(wire: String?): Boolean =
            wire in RETIRED_TRANSACTION_WIRES
    }
}

internal enum class PaymentSourceRoute {
    BILL_PAY,
    CARD_TRANSACTION,
    BITCOIN_TRANSACTION,
}

/**
 * Durable selector storage. Only the stable wire is persisted; a renamed label
 * cannot strand a previously selected source.
 */
internal class PaymentSourceStore(
    private val preferences: SharedPreferences,
) {
    constructor(context: Context) : this(
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE),
    )

    fun current(): PaymentSource = PaymentSource.fromWireOrDefault(storedWire())

    fun storedWire(): String? = preferences.getString(KEY_PAYMENT_SOURCE_WIRE, null)

    fun select(source: PaymentSource): Boolean =
        preferences.edit()
            .putString(KEY_PAYMENT_SOURCE_WIRE, source.wire)
            .commit()

    private companion object {
        const val PREFERENCES_NAME = "payment-source-selection"
        const val KEY_PAYMENT_SOURCE_WIRE = "payment_source_wire"
    }
}
