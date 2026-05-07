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

### Wasabi Card Provider

`services/WasabiService.js` wraps all card provider API calls. Uses RSA-SHA256 request signing (`WASABI_API_SECRET` is an RSA private key). Sensitive card data (number, CVV) comes back RSA-encrypted and is decrypted via `decryptRsa()`. Card types are configured via `WASABI_VIRTUAL_CARD_TYPE_ID` / `WASABI_PHYSICAL_CARD_TYPE_ID` env vars.

Key card flow in `controllers/user/cardController.js` (`applyCard`):
1. Validate complete user profile + KYC status
2. Resolve physical card number from inventory (if physical)
3. Deduct wallet balance (deposit amount + fee)
4. Create `Card` record (status=`processing`)
5. Call Wasabi `createHolder()` then `createCard()`
6. Update card with Wasabi IDs (status=`pending`)
7. Write `CommissionLedger` entry

### Environment Variables

Copy `.env.example` to `.env`. Critical vars:

```
MONGO_URI              # MongoDB connection string
JWT_SECRET             # User JWT signing key
JWT_ADMIN_SECRET       # Admin JWT signing key
JWT_MERCHANT_SECRET    # Merchant JWT signing key
API_KEY                # X-API-Key for external /api/cards/* routes
WASABI_API_URL         # Card provider base URL
WASABI_API_KEY         # Card provider API key
WASABI_API_SECRET      # RSA private key (PEM) for request signing
WASABI_VIRTUAL_CARD_TYPE_ID
WASABI_PHYSICAL_CARD_TYPE_ID
ENCRYPTION_KEY         # 32-byte hex key for encrypting wallet mnemonics
```

Note: `app.js` sets custom DNS servers (8.8.8.8, 1.1.1.1) at startup to bypass network filtering — do not remove.

### Large Controllers

Two controllers are intentionally large and domain-rich:

- `controllers/user/cardController.js` (~735 lines) — all card lifecycle: apply, topup, withdraw, freeze/unfreeze, terminate, activate, PIN update, reveal
- `controllers/admin/adminController.js` (~749 lines) — full admin panel: users, KYC, deposits, withdrawals, commissions, hot wallets, card inventory, impersonation
