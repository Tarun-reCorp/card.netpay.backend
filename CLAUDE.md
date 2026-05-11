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
- `/api/admin` — dashboard, user/KYC management, deposits/withdrawals approval, commission settings, hot wallets, physical card inventory, merchant management
- `/api/merchant` — merchant dashboard, card list, physical card assignment, user list
- `/api/cards` — external REST API for programmatic card management (API-key protected)

### Key Domain Concepts

**Commission System**: Three-layer override — global `CommissionSetting` defaults → per-merchant `MerchantCommissionSetting` → per-user `UserCommissionSetting`. Types: `card_issuance_virtual`, `card_issuance_physical`, `card_topup`, `deposit`, `withdrawal`. Each has `rateType` (percentage/fixed) and `rate`.

**Physical Card Inventory**: `PhysicalCardNumber` records are assigned in priority order: `preAssignedUserId` (specific user) → `merchantId` pool → unassigned general pool. The `applyCard()` controller enforces this lookup order.

**Wallet Model**: `Wallet` has `balance` (available) and `locked` (funds held pending withdrawal approval). Card issuance/topup deducts from `balance` immediately; withdrawals lock funds until admin approval.

**Crypto Deposits**: 8 chains supported (BEP20, TRC20, ERC20, POLYGON, ARBITRUM, BASE, AVALANCHE, OPTIMISM). `Deposit` records track confirmation count vs `requiredConfs` (default 15). `WalletAddress` stores one pre-generated address per user per chain.

### UQPay Card Provider

`services/UqpayService.js` wraps all card provider API calls. Auth via short-lived `x-auth-token` (cached in `UqpayToken` collection, refreshed via `/connect/token`). Sensitive card data (number, CVV) is retrieved via `getCardSensitiveInfo`. Products and card BINs come from `/issuing/products`.

Key card flow in `controllers/user/cardController.js` (`applyCard`):
1. Validate KYC status, wallet balance, card type
2. Get-or-create `UqpayCardholder` for this user (`POST /issuing/cardholders`)
3. If physical: atomically reserve a `PhysicalCardNumber` from inventory (pre-assigned → merchant pool → general pool)
4. Deduct wallet balance + create local `Card` (status=`processing`) + write `WalletTransaction` + `CommissionLedger`
5. Call UQPay — virtual: `POST /issuing/cards` (`createCard`); physical: `POST /issuing/cards/assign` (`assignCard`)
6. On success: update `Card.uqpayCardId`, status=`pending`. On failure: roll back wallet + release physical card to inventory.

Card lifecycle endpoints under `/api/user/cards/*` (and merchant-facing `/api/cards/*` with `X-API-Key`): apply, topup (`rechargeCard`), withdraw (`withdrawCard`), freeze/unfreeze/terminate (`updateCardStatus`), activate (sets PIN via `resetCardPin`), update PIN, reveal (`getCardSensitiveInfo`), transactions (`getCardOrders`).

### Environment Variables

Copy `.env.example` to `.env`. Critical vars:

```
MONGO_URI              # MongoDB connection string
JWT_SECRET             # User JWT signing key
JWT_ADMIN_SECRET       # Admin JWT signing key
JWT_MERCHANT_SECRET    # Merchant JWT signing key
API_KEY                # X-API-Key for external /api/cards/* routes
UQPAY_API_URL          # UQPay base URL (sandbox: https://api-sandbox.uqpaytech.com/api/v1)
UQPAY_API_KEY          # UQPay API key (for /connect/token)
UQPAY_CLIENT_ID        # UQPay client id (for /connect/token)
ENCRYPTION_KEY         # 32-byte hex key for encrypting wallet mnemonics
```

Note: `app.js` sets custom DNS servers (8.8.8.8, 1.1.1.1) at startup to bypass network filtering — do not remove.

### Large Controllers

Two controllers are intentionally large and domain-rich:

- `controllers/user/cardController.js` (~735 lines) — all card lifecycle: apply, topup, withdraw, freeze/unfreeze, terminate, activate, PIN update, reveal
- `controllers/admin/adminController.js` (~749 lines) — full admin panel: users, KYC, deposits, withdrawals, commissions, hot wallets, card inventory, impersonation
