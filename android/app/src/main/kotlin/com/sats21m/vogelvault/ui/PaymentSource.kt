package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.SharedPreferences

/**
 * User-facing payment sources with a closed, persisted wire contract.
 *
 * The wire is what belongs in a transaction row or handoff. Labels are presentation
 * text and must not be used for routing or persistence.
 */
internal enum class PaymentSource(
    val wire: String,
    val label: String,
    val route: PaymentSourceRoute,
) {
    RIVER_BITCOIN_BILL_PAY(
        wire = "river_bitcoin_bill_pay",
        label = "River Bitcoin Bill Pay",
        route = PaymentSourceRoute.BILL_PAY,
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
    LIGHTNING(
        wire = "lightning",
        label = "Lightning",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    ON_CHAIN(
        wire = "on_chain",
        label = "On-chain",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    );

    val isBitcoinTransaction: Boolean
        get() = route == PaymentSourceRoute.BITCOIN_TRANSACTION

    companion object {
        val DEFAULT: PaymentSource = COINBASE_CARD

        fun fromWire(wire: String?): PaymentSource =
            entries.firstOrNull { it.wire == wire } ?: DEFAULT
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

    fun current(): PaymentSource = PaymentSource.fromWire(storedWire())

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
