// Central status definitions used across models and controllers.
// Import named constants when comparing/writing values; pass the *_VALUES
// array straight into mongoose `enum` definitions.

const CARD_STATUS = Object.freeze({
  PENDING:    'pending',
  ACTIVE:     'active',
  FROZEN:     'frozen',
  CANCELLED:  'cancelled',
  PROCESSING: 'processing',
  FAILED:     'failed',
});

const DEPOSIT_STATUS = Object.freeze({
  PENDING:    'pending',
  CONFIRMING: 'confirming',
  CONFIRMED:  'confirmed',
  COMPLETED:  'completed',
  REJECTED:   'rejected',
});

const MERCHANT_STATUS = Object.freeze({
  ACTIVE:   'active',
  INACTIVE: 'inactive',
});

const KYC_STATUS = Object.freeze({
  NOT_SUBMITTED: 'not_submitted',
  PENDING:       'pending',
  IN_REVIEW:     'in_review',
  APPROVED:      'approved',
  REJECTED:      'rejected',
});

const TRANSACTION_STATUS = Object.freeze({
  PENDING:    'pending',
  APPROVED:   'approved',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  REJECTED:   'rejected',
  FAILED:     'failed',
});

const WITHDRAWAL_STATUS = Object.freeze({
  PENDING:    'pending',
  APPROVED:   'approved',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  FAILED:     'failed',
  REJECTED:   'rejected',
});

module.exports = {
  CARD_STATUS,
  DEPOSIT_STATUS,
  MERCHANT_STATUS,
  KYC_STATUS,
  TRANSACTION_STATUS,
  WITHDRAWAL_STATUS,

  CARD_STATUS_VALUES:        Object.values(CARD_STATUS),
  DEPOSIT_STATUS_VALUES:     Object.values(DEPOSIT_STATUS),
  MERCHANT_STATUS_VALUES:    Object.values(MERCHANT_STATUS),
  KYC_STATUS_VALUES:         Object.values(KYC_STATUS),
  TRANSACTION_STATUS_VALUES: Object.values(TRANSACTION_STATUS),
  WITHDRAWAL_STATUS_VALUES:  Object.values(WITHDRAWAL_STATUS),
};
