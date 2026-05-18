# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Development (auto-reload)
npm run dev

# Production
npm start

# Seed demo accounts (user/admin/merchant) and sample data
node seed.js

# Seed default commission settings and app config
node scripts/seedCommission.js
```

Default API base: `http://localhost:5000/api`

## Architecture

This is a **Node.js/Express backend** for a multi-tenant prepaid card platform. MongoDB (Mongoose) is the database. There is no test suite configured.

### Three-Portal Authentication

Three separate JWT secrets and middleware for three principal types:

| Principal | Secret env var | Middleware | Attached as |
|-----------|---------------|-----------|-------------|
| User | `JWT_SECRET` | `authMiddleware` | `req.user` |
| Admin | `JWT_ADMIN_SECRET` | `adminAuthMiddleware` | `req.admin` |
| Merchant | `JWT_MERCHANT_SECRET` | `merchantAuthMiddleware` | `req.merchant` |

External card API routes (`/api/cards/*`) use header-based API key auth (`X-API-Key` vs `API_KEY` env var) via `apiKeyMiddleware`.

### Route Structure

All routes are mounted under `/api` via `routes/index.js`:

- `/api/auth` — user registration, login, 2FA (TOTP via speakeasy), password reset
- `/api/user` — profile, KYC upload, wallet, card lifecycle
- `/api/admin` — split across `adminController` (users, KYC, deposits, withdrawals, commissions, physical-card inventory, admin-user 2FA), `merchantController` (merchant CRUD + commission overrides + login-as), `cryptoAdminController` (chain toggles, hot/admin wallets, crypto deposits/withdrawals, gas treasury, wallet-service logs), and `uqpayController` (UQPay cardholders/cards/products passthrough)
- `/api/merchant` — merchant dashboard, card list, physical card assignment, user list
- `/api/cards` — external REST API for programmatic card management (API-key protected); see "Public REST API" below

**Route ordering gotcha:** within each router, static paths (e.g. `/cards/products`, `/cards/stats`, `/physical-cards/stats`) MUST be declared before dynamic `/cards/:id` routes or Express will treat `products`/`stats` as an `:id`. The route files have comments marking these boundaries — preserve them.

### Key Domain Concepts

**Commission System**: Three-layer override — global `CommissionSetting` defaults → per-merchant `MerchantCommissionSetting` → per-user `UserCommissionSetting`. Types: `card_issuance_virtual`, `card_issuance_physical`, `card_deposit`, `card_withdrawal`, `deposit`, `withdrawal`. Each has `rateType` (percentage/fixed) and `rate`.

**Physical Card Inventory**: `PhysicalCardNumber` records are assigned in priority order: `preAssignedUserId` (specific user) → `merchantId` pool → unassigned general pool. The `applyCard()` controller enforces this lookup order.

**Wallet Model**: `Wallet` has `balance` (available) and `locked` (funds held pending withdrawal approval). Card issuance/deposit deducts from `balance` immediately; withdrawals lock funds until admin approval.

**Crypto Deposits**: 8 chains supported (BEP20, TRC20, ERC20, POLYGON, ARBITRUM, BASE, AVALANCHE, OPTIMISM). `Deposit` records track confirmation count vs `requiredConfs` (default 15). `WalletAddress` stores one pre-generated address per user per chain. **This backend does not do HD derivation or sign on-chain transactions** — no `ethers`/`TronWeb`/`bip39` dependencies. Address generation and on-chain signing live in a separate wallet service (the sibling Laravel/Node `wallet-service`); this app only persists addresses, verifies confirmations, and credits wallets.

**Central status registry**: `config/statuses.js` exports frozen enums + `*_VALUES` arrays for `CARD`, `DEPOSIT`, `WITHDRAWAL`, `TRANSACTION`, `KYC`, `MERCHANT` statuses. Mongoose schemas pull `enum: *_STATUS_VALUES` from here, and controllers compare against the named constants. **Do not hard-code status strings** — import from `config/statuses.js` so the enum and consumers can never drift.

### UQPay Card Provider

`services/UqpayService.js` wraps all card provider API calls. Auth via short-lived `x-auth-token` (cached in `UqpayToken` collection, refreshed via `/connect/token`). Sensitive card data (number, CVV) is retrieved via `getCardSensitiveInfo`. Products and card BINs come from `/issuing/products`.

Every UQPay HTTP request goes through a single `request()` chokepoint that times the call and writes one row to `uqpay_api_logs` (`UqpayApiLog` model) capturing method, path, request body, response body, status, and duration. Bodies are truncated at 16 KB. The admin route `GET /admin/uqpay-api-logs` reads from this collection — when debugging provider issues, check there first rather than re-running calls.

Key card flow in `controllers/user/cardController.js` (`applyCard`):
1. Validate KYC status, wallet balance, card type
2. Get-or-create `UqpayCardholder` for this user (`POST /issuing/cardholders`)
3. If physical: atomically reserve a `PhysicalCardNumber` from inventory (pre-assigned → merchant pool → general pool)
4. Deduct wallet balance + create local `Card` (status=`processing`) + write `WalletTransaction` + `CommissionLedger`
5. Call UQPay — virtual: `POST /issuing/cards` (`createCard`); physical: `POST /issuing/cards/assign` (`assignCard`)
6. On success: update `Card.uqpayCardId`, status=`pending`. On failure: roll back wallet + release physical card to inventory.

User-facing card lifecycle endpoints under `/api/user/cards/*`: `apply`, `deposit` (`rechargeCard`), `withdraw` (`withdrawCard`), `freeze`/`unfreeze`/`terminate` (`updateCardStatus`), `activate` (sets PIN via `resetCardPin`), `update-pin`, `reveal` (`getCardSensitiveInfo`), `transactions` (`getCardOrders`).

### Public REST API (`/api/cards/*`, X-API-Key)

Handled by `controllers/api/cardApiController.js`. **Different shape from the user-facing routes** — these are explicitly merchant-facing and use UQPay's vocabulary:

- `GET  /api/health` — liveness check
- `POST /api/cards/holder` — create-or-return `UqpayCardholder` for a `userId`
- `POST /api/cards/issue` — issue virtual (`createCard`) or assign physical (`assignCard`); requires `card_product_id`, plus `card_number` for physical
- `GET  /api/cards/holder/:holderId` — list cards for a cardholder
- `GET  /api/cards/:cardId/balance` | `GET /api/cards/:cardId/transactions` | `GET /api/cards/:cardId/reveal`
- `POST /api/cards/:cardId/load` | `unload` | `freeze` | `unfreeze` | `terminate`

This route group bypasses the wallet/commission flow in the user `applyCard` — it's a thin passthrough to UQPay intended for merchants who manage their own ledger.

### Environment Variables

Copy `.env.example` to `.env`. Critical vars:

```
MONGO_URI              # MongoDB connection string
JWT_SECRET             # User JWT signing key
JWT_ADMIN_SECRET       # Admin JWT signing key
JWT_MERCHANT_SECRET    # Merchant JWT signing key
JWT_EXPIRES_IN         # Token TTL (default 7d)
API_KEY                # X-API-Key for external /api/cards/* routes
UQPAY_API_URL          # UQPay base URL (sandbox: https://api-sandbox.uqpaytech.com/api/v1)
UQPAY_API_KEY          # UQPay API key (for /connect/token)
UQPAY_CLIENT_ID        # UQPay client id (for /connect/token)
AWS_REGION             # KYC documents are uploaded directly to S3 via multer-s3
AWS_BUCKET             # and served back via presigned GET URLs (1h expiry)
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

`.env.example` lists an `ENCRYPTION_KEY` for "wallet mnemonics" — **this is a leftover from the sibling Laravel codebase and is not referenced anywhere in this Node app**. Safe to ignore until wallet derivation is migrated in.

Note: `app.js` sets custom DNS servers (8.8.8.8, 1.1.1.1) at startup to bypass network filtering — do not remove.

### Large Controllers

Two controllers are intentionally large and domain-rich — don't split them speculatively:

- `controllers/user/cardController.js` (~1000 lines) — all card lifecycle: apply, deposit, withdraw, freeze/unfreeze, terminate, activate, PIN update, reveal. Includes the atomic physical-card reservation/release helpers (`reservePhysicalCardNumber`, `releasePhysicalCardNumber`) and PIN-weakness checks.
- `controllers/admin/adminController.js` (~1400 lines) — full admin panel: users, KYC, deposits, withdrawals, commissions, hot wallets, card inventory, impersonation, admin-user 2FA management.
