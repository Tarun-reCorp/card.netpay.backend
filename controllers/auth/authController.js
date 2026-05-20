const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const Merchant = require('../../models/Merchant');
const { presign } = require('../../lib/s3');
const { userBrandSummary, MERCHANT_BRAND_SELECT } = require('../../lib/userBrand');

const SETUP_TOKEN_TTL     = '15m';
const MFA_CHALLENGE_TTL   = '5m';

function issueAuthToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
}

function issueSetupToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa_setup' }, process.env.JWT_SECRET, { expiresIn: SETUP_TOKEN_TTL });
}

// Minted ONLY after a successful password check on /login. Carries the user
// id plus a fixed purpose claim so it can't be confused with an auth token.
// Required to call /2fa/verify — closes the bypass where an attacker who
// knew a userId + a current TOTP code could issue a session without ever
// proving the password.
function issueMfaChallengeToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa_challenge' }, process.env.JWT_SECRET, { expiresIn: MFA_CHALLENGE_TTL });
}

function verifySetupToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_setup') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

function verifyMfaChallengeToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_challenge') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

// Legacy summary used when the user doc was loaded without populating the
// merchant. Prefer `userBrandSummary` (from lib/userBrand) for any new code
// — it returns the full payload with the merchant brand block, which the
// frontend Layout needs to theme on the first render after login.
function userSummary(u) {
  return { id: u._id, name: u.name, email: u.email, kycStatus: u.kycStatus };
}

// POST /auth/register
exports.register = async (req, res) => {
  try {
    const { name, email, password, firstName, lastName, birthday, gender, country, countryName, phone, areaCode, mobile, town, address, postCode, merchantId, merchantTag } = req.body;

    const exists = await User.findOne({ email });
    if (exists) return res.status(422).json({ success: false, message: 'Email already registered' });

    // Resolve merchantId from tag if provided
    let resolvedMerchantId = merchantId || null;
    if (!resolvedMerchantId && merchantTag) {
      const merchant = await Merchant.findOne({ tag: merchantTag.toLowerCase(), status: 'active' });
      if (merchant) resolvedMerchantId = merchant._id;
    }

    const hashed = await bcrypt.hash(password, 12);
    const created = await User.create({ name, email, password: hashed, firstName, lastName, birthday, gender, country, countryName, phone, areaCode, mobile, town, address, postCode, merchantId: resolvedMerchantId });

    await Wallet.create({ userId: created._id });

    // Re-load with merchant populated so the response carries brand fields
    // — frontend can theme the dashboard on the very first render.
    const user = await User.findById(created._id).populate({ path: 'merchantId', select: MERCHANT_BRAND_SELECT });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.status(201).json({ success: true, token, user: await userBrandSummary(user) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /auth/merchant-brand/:tag  — public, returns branding for white-label login
exports.getMerchantBrand = async (req, res) => {
  try {
    const merchant = await Merchant.findOne({ tag: req.params.tag.toLowerCase(), status: 'active' })
      .select('name tag logo cardImage primaryColor secondaryColor titleTag showPoweredBy type');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const data = merchant.toObject();
    // Whitelabel merchants never show "Powered by NetPay" (mirrors PHP Merchant::showPoweredBy())
    if (data.type === 'whitelabel') data.showPoweredBy = false;

    // The frontend used to construct logo URLs by prepending UPLOADS_BASE to
    // a local path, but logos now live in S3 as opaque object keys. Replace
    // the key with a 1h presigned GET URL so <img src> works without any
    // path-joining gymnastics on the client.
    data.logo      = await presign(data.logo);
    data.cardImage = await presign(data.cardImage);

    res.json({ success: true, merchant: data });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/login
//
// Accepts an optional `merchantTag` body param. When present, the login is
// scoped to that merchant's white-label portal — only users whose
// `merchantId.tag` matches are allowed through. This prevents merchant A's
// user from signing in via merchant B's URL (`/{tagB}`) and direct users
// (no merchantId) from bleeding into any merchant portal.
exports.login = async (req, res) => {
  try {
    // Belt-and-braces coercion. The sanitizeMongo middleware already strips
    // operator keys from req.body, but a String() cast guarantees the lookup
    // and bcrypt.compare both receive primitives even if the input shape
    // changes elsewhere.
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    const password = typeof req.body?.password === 'string' ? req.body.password : null;
    const merchantTag = typeof req.body?.merchantTag === 'string'
      ? req.body.merchantTag.trim().toLowerCase()
      : null;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    // Populate the merchant brand inline so the success response carries
    // primary/secondary colors + presigned logoUrl — avoids a /user/profile
    // round-trip and the resulting flicker on the frontend.
    const user = await User.findOne({ email }).populate({
      path: 'merchantId',
      select: MERCHANT_BRAND_SELECT,
    });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.isBlocked) return res.status(403).json({ success: false, message: 'Account blocked' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // Merchant-portal scoping. Done after the password check so the error
    // message can't be used to enumerate which emails belong to which merchant.
    //
    // Two-way gate:
    //   • merchantTag given but user.merchantId missing → reject (direct user
    //     trying to sign in via a whitelabel portal)
    //   • merchantTag given but doesn't match user.merchantId.tag → reject
    //     (cross-merchant login attempt)
    //   • merchantTag NOT given but user.merchantId is set → reject and point
    //     them to their own portal (prevents the generic /login from
    //     bypassing whitelabel scoping)
    // Merchant scoping: `user.merchantId` is the populated merchant doc here
    // (or null when user has no merchant).
    const userMerchant = user.merchantId;
    if (merchantTag) {
      if (!userMerchant) {
        return res.status(403).json({
          success: false,
          message: 'This account is not registered under this merchant portal',
        });
      }
      const mTag = (userMerchant.tag || '').toLowerCase();
      if (mTag !== merchantTag) {
        return res.status(403).json({
          success: false,
          message: 'This account belongs to a different merchant portal',
        });
      }
    } else if (userMerchant) {
      const portalHint = userMerchant.tag ? ` Please sign in at /${userMerchant.tag}.` : '';
      return res.status(403).json({
        success: false,
        message: `This account belongs to a merchant portal.${portalHint}`,
        merchantTag: userMerchant.tag || null,
      });
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      // Return an opaque challenge token instead of the raw userId so the
      // /2fa/verify endpoint can prove the caller also passed the password
      // check above. Without the token, /2fa/verify refuses.
      return res.json({
        success: true,
        requires2FA: true,
        mfaChallengeToken: issueMfaChallengeToken(user._id),
      });
    }

    if (user.twoFactorRequired) {
      return res.json({
        success: true,
        requires2FASetup: true,
        userId: user._id,
        setupToken: issueSetupToken(user._id),
      });
    }

    res.json({ success: true, token: issueAuthToken(user._id), user: await userBrandSummary(user) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/google
//
// Body: { code, merchantTag?, redirectUri? }
//
// Google Identity Services authorization-code flow. Frontend uses
// `google.accounts.oauth2.initCodeClient({ ux_mode: 'popup' })` to obtain an
// authorization code, which we exchange server-side using the client secret
// so the secret never leaves the backend. The exchange returns an ID token
// whose payload we use to identify the user.
//
// IMPORTANT — flow parity with /auth/login:
//   • merchant scoping (merchantTag) is enforced identically
//   • 2FA gate is enforced identically (requires2FA / requires2FASetup paths)
//   • isBlocked check identical
//   • returns the same { token, user } shape on success
// Anything that calls /auth/login expecting one of those response shapes
// will get the same shape here. AuthContext consumes this without changes.
exports.googleAuth = async (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : null;
    const merchantTag = typeof req.body?.merchantTag === 'string'
      ? req.body.merchantTag.trim().toLowerCase()
      : null;
    // GIS popup flow uses the literal string 'postmessage' as redirect_uri —
    // backend MUST exchange with the same value. Frontend sends 'postmessage'
    // by default; redirectUri override exists for any future redirect flow.
    const redirectUri = typeof req.body?.redirectUri === 'string' && req.body.redirectUri.trim()
      ? req.body.redirectUri.trim()
      : 'postmessage';

    if (!code) return res.status(400).json({ success: false, message: 'code is required' });
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      console.error('[googleAuth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from env');
      return res.status(500).json({ success: false, message: 'Google auth is not configured' });
    }

    // 1. Exchange authorization code for tokens
    let tokenData;
    try {
      const tokenRes = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          code,
          client_id:     process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
      );
      tokenData = tokenRes.data;
    } catch (err) {
      console.error('[googleAuth] token exchange failed:', err.response?.data || err.message);
      return res.status(401).json({ success: false, message: 'Google authentication failed' });
    }

    const idToken = tokenData?.id_token;
    if (!idToken) return res.status(401).json({ success: false, message: 'Google returned no ID token' });

    // 2. Validate the ID token via Google's tokeninfo endpoint. We received
    // it over HTTPS in step 1, but tokeninfo gives belt-and-braces signature
    // + claim validation without bundling a JWKS client.
    let profile;
    try {
      const verifyRes = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
        params:  { id_token: idToken },
        timeout: 10_000,
      });
      profile = verifyRes.data;
    } catch (err) {
      console.error('[googleAuth] tokeninfo verify failed:', err.response?.data || err.message);
      return res.status(401).json({ success: false, message: 'Failed to verify Google identity' });
    }

    // Audience must match — protects against tokens issued for other apps.
    if (profile.aud !== process.env.GOOGLE_CLIENT_ID) {
      console.warn('[googleAuth] token audience mismatch:', profile.aud);
      return res.status(401).json({ success: false, message: 'Invalid Google client' });
    }

    const email = (profile.email || '').toLowerCase().trim();
    const emailVerified = profile.email_verified === 'true' || profile.email_verified === true;
    if (!email) return res.status(401).json({ success: false, message: 'No email returned from Google' });
    if (!emailVerified) {
      return res.status(401).json({ success: false, message: 'Google account email is not verified' });
    }

    // 3. Look up user. Same gates as /auth/login below.
    let user = await User.findOne({ email }).populate({
      path:   'merchantId',
      select: MERCHANT_BRAND_SELECT,
    });

    if (user) {
      if (user.isBlocked) return res.status(403).json({ success: false, message: 'Account blocked' });

      // Merchant-portal scoping — mirror /auth/login exactly so a Google
      // sign-in cannot bypass tag scoping that password sign-in enforces.
      const userMerchant = user.merchantId;
      if (merchantTag) {
        if (!userMerchant) {
          return res.status(403).json({
            success: false,
            message: 'This account is not registered under this merchant portal',
          });
        }
        const mTag = (userMerchant.tag || '').toLowerCase();
        if (mTag !== merchantTag) {
          return res.status(403).json({
            success: false,
            message: 'This account belongs to a different merchant portal',
          });
        }
      } else if (userMerchant) {
        const portalHint = userMerchant.tag ? ` Please sign in at /${userMerchant.tag}.` : '';
        return res.status(403).json({
          success: false,
          message: `This account belongs to a merchant portal.${portalHint}`,
          merchantTag: userMerchant.tag || null,
        });
      }

      if (user.twoFactorEnabled && user.twoFactorSecret) {
        return res.json({
          success: true,
          requires2FA: true,
          mfaChallengeToken: issueMfaChallengeToken(user._id),
        });
      }
      if (user.twoFactorRequired) {
        return res.json({
          success: true,
          requires2FASetup: true,
          userId: user._id,
          setupToken: issueSetupToken(user._id),
        });
      }

      return res.json({
        success: true,
        token:   issueAuthToken(user._id),
        user:    await userBrandSummary(user),
      });
    }

    // 4. New user — auto-create from Google profile. password is required by
    // schema, so set a random hash that's never used (user can run
    // /forgot-password later if they ever want an email/password login).
    let resolvedMerchantId = null;
    if (merchantTag) {
      const merchant = await Merchant.findOne({ tag: merchantTag, status: 'active' });
      if (merchant) resolvedMerchantId = merchant._id;
    }

    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashed = await bcrypt.hash(randomPassword, 12);
    const name = profile.name
      || `${profile.given_name || ''} ${profile.family_name || ''}`.trim()
      || email.split('@')[0];

    const created = await User.create({
      name,
      email,
      password:   hashed,
      firstName:  profile.given_name  || null,
      lastName:   profile.family_name || null,
      merchantId: resolvedMerchantId,
    });
    await Wallet.create({ userId: created._id });

    user = await User.findById(created._id).populate({ path: 'merchantId', select: MERCHANT_BRAND_SELECT });
    return res.status(201).json({
      success: true,
      token:   issueAuthToken(user._id),
      user:    await userBrandSummary(user),
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/2fa/verify
//
// Now requires { mfaChallengeToken, code }. The challenge token is only
// issued by /login on a successful password match, so this endpoint can no
// longer be hit with a bare userId. Legacy { userId, code } payloads are
// rejected with 400.
exports.verify2FA = async (req, res) => {
  try {
    const { mfaChallengeToken, code } = req.body;
    if (!mfaChallengeToken) {
      return res.status(400).json({ success: false, message: 'mfaChallengeToken is required' });
    }
    const userId = verifyMfaChallengeToken(mfaChallengeToken);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid or expired challenge token' });

    // Populate merchant brand here too so the post-2FA login response carries
    // the same payload as the no-2FA path — frontend treats them uniformly.
    const user = await User.findById(userId).populate({ path: 'merchantId', select: MERCHANT_BRAND_SELECT });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ success: false, message: '2FA is not enabled for this account' });
    }

    const valid = speakeasy.totp.verify({
      secret: user.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

    res.json({ success: true, token: issueAuthToken(user._id), user: await userBrandSummary(user) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/2fa/setup-forced   body: { setupToken }
// Issued during forced setup at login. Generates a new TOTP secret on the user
// (twoFactorEnabled stays false until enable-forced confirms a code).
exports.setup2FAForced = async (req, res) => {
  try {
    const { setupToken } = req.body;
    const userId = verifySetupToken(setupToken);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const issuer = process.env.APP_NAME || 'NetPay';
    const secret = speakeasy.generateSecret({ name: `${issuer} (${user.email})` });

    // Atomic precondition: only write a fresh secret if 2FA is NOT already
    // enabled. Prevents a phished/leaked setupToken from rebinding an
    // already-enrolled account to an attacker's authenticator app. The
    // canonical disable/re-enroll path is via the admin "Require 2FA" toggle
    // which clears twoFactorSecret and twoFactorEnabled together.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, twoFactorEnabled: { $ne: true } },
      { $set: { twoFactorSecret: secret.base32, twoFactorEnabled: false } },
      { new: true },
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: '2FA is already enabled for this account.' });
    }

    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, qrCode: qr, secret: secret.base32 });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/2fa/enable-forced  body: { setupToken, code }
// Confirms the freshly-issued TOTP and finalizes the login (returns auth token).
exports.enable2FAForced = async (req, res) => {
  try {
    const { setupToken, code } = req.body;
    const userId = verifySetupToken(setupToken);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const user = await User.findById(userId).populate({ path: 'merchantId', select: MERCHANT_BRAND_SELECT });
    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({ success: false, message: 'Run setup first' });
    }

    const valid = speakeasy.totp.verify({
      secret: user.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid code' });

    await User.findByIdAndUpdate(user._id, { twoFactorEnabled: true });
    res.json({ success: true, token: issueAuthToken(user._id), user: await userBrandSummary(user) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /auth/2fa/setup  (requires auth)
exports.setup2FA = async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `${process.env.APP_NAME} (${req.user.email})` });
    await User.findByIdAndUpdate(req.user._id, { twoFactorSecret: secret.base32 });

    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, qrCode: qr, secret: secret.base32 });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/2fa/enable  (requires auth)
exports.enable2FA = async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.user._id);

    const valid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid code' });

    await User.findByIdAndUpdate(user._id, { twoFactorEnabled: true });
    res.json({ success: true, message: '2FA enabled' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/forgot-password
// Always returns a generic acknowledgement so existence/2FA state of an account
// is never disclosed in the HTTP body. The reset token is delivered out-of-band
// (email) — never echoed back to the caller.
exports.forgotPassword = async (req, res) => {
  const GENERIC_OK = {
    success: true,
    message: 'If an account exists for this email, password reset instructions have been sent.',
  };
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : null;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json(GENERIC_OK);

    // For 2FA-enabled accounts: a TOTP-gated reset flow is not yet wired.
    // Do not leak that 2FA is enabled — return the same generic response and
    // log server-side so support can assist out-of-band.
    if (user.twoFactorEnabled) {
      console.warn('[forgotPassword] 2FA-enabled user requested reset — handle out-of-band. userId=%s email=%s', user._id, user.email);
      return res.json(GENERIC_OK);
    }

    // Generate a one-time reset JWT. It is NOT returned in the response body —
    // an out-of-band channel (email) must deliver it. Until SMTP is wired,
    // the token is emitted to server logs only so an operator can hand-deliver
    // during the cutover. Replace this log with a real mailer.
    const resetToken = jwt.sign(
      { id: user._id, purpose: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    console.warn('[forgotPassword] DELIVER OUT-OF-BAND. userId=%s email=%s resetToken=%s', user._id, user.email, resetToken);

    return res.json(GENERIC_OK);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/reset-password
exports.resetPassword = async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== 'reset') return res.status(400).json({ success: false, message: 'Invalid token' });

    const hashed = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(decoded.id, { password: hashed });
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Invalid or expired token' });
  }
};
