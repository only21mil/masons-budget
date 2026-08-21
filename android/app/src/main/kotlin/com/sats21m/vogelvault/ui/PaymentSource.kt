package com.sats21m.vogelvault.ui

import android.content.Context
import android.content.SharedPreferences

/**
 * User-facing payment sources with a closed, persisted wire contract.
 *
 * The wire is the durable selector identity used for routing and selector storage.
 * [persistedCard] is the canonical transaction-row vocabulary; keep the two
 * contracts separate so selector implementation details never leak into ledger rows.
 */
internal enum class PaymentSource(
    val wire: String,
    val label: String,
    val persistedCard: String,
    val route: PaymentSourceRoute,
) {
    RIVER_BITCOIN_BILL_PAY(
        wire = "river_bitcoin_bill_pay",
        label = "River Bitcoin Bill Pay",
        persistedCard = "River Bitcoin Bill Pay",
        route = PaymentSourceRoute.BILL_PAY,
    ),
    COINBASE_CARD(
        wire = "coinbase_card",
        label = "Coinbase Card",
        persistedCard = "Coinbase Card",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    AVEN(
        wire = "aven",
        label = "Aven",
        persistedCard = "Aven",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    SOFI_CARD(
        wire = "sofi_card",
        label = "SoFi Card",
        persistedCard = "SoFi Card",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    CAPITAL_ONE_VX(
        wire = "capital_one_vx",
        label = "Capital One VX",
        persistedCard = "Capital One VX",
        route = PaymentSourceRoute.CARD_TRANSACTION,
    ),
    LIGHTNING(
        wire = "lightning",
        label = "Lightning",
        persistedCard = "lightning",
        route = PaymentSourceRoute.BITCOIN_TRANSACTION,
    ),
    ON_CHAIN(
        wire = "on_chain",
        label = "On-chain",
        persistedCard = "on-chain",
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
