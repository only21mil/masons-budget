# Privacy Policy — The Vogel Vault

**Last updated: July 28, 2026**

## What We Collect

The Vogel Vault collects **no personal financial data from banks or financial institutions**. There is no Plaid integration, no bank linking, and no third-party data aggregation.

### Data You Enter
- **Transactions**: Amounts, merchants, categories, and optional notes that you enter manually or via voice
- **Voice input**: Audio submitted to Apple's speech-recognition framework and not retained by the app after recognition
- **Budget preferences**: Category names, icons, and budget amounts you configure

### Data Read from Convex
- Household financial data stored in the Vogel Vault Convex deployment (budgets, transactions, balances, holdings, and todos)

## Where Data Lives

The app stores a local SwiftData cache on your device. The household ledger's system of record is a private Convex deployment, and the app refreshes its local cache from that backend.

## Data Sharing

**We do not sell your financial data.** The app transmits ledger reads and approved writes to the household's Convex deployment. It also requests market prices from the Vogel Vault price endpoint and, when fallbacks are needed, CoinGecko, Coinbase, or Yahoo Finance. Voice entry uses Apple's speech-recognition framework.

## Permissions

- **Microphone and speech recognition**: Used only for voice transaction entry. The app does not retain the recording after recognition.

## Children

The Vogel Vault is designed for family use. Children's records are stored in the household's Convex deployment and are visible according to the app's family-profile rules. No data is collected from children beyond what the family chooses to enter.

## Your Rights

Removing the app deletes its local cache from that device. Deleting records from the household backend requires an approved Vogel Vault write or administrative process.

## Contact

For questions about this privacy policy, contact Victor Vogel at thevictorvogel@gmail.com.
