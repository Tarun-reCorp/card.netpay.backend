const bcrypt = require('bcryptjs');
const User = require('../../models/User');
const { presign } = require('../../lib/s3');

// GET /user/profile
//
// Now populates the owning merchant (if any) so the user panel can theme
// itself with the merchant's brand colors. Direct users (no merchantId)
// get `user.merchant === null`, which the frontend treats as "default
// emerald theme" — i.e. no behavioral change for them.
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password -twoFactorSecret')
      .populate({
        path: 'merchantId',
        select: 'name tag titleTag type primaryColor secondaryColor logo cardImage showPoweredBy',
      });

    // Detach merchant onto a clean `user.merchant` key with presigned brand
    // assets. Frontend AuthContext stashes this in localStorage; the user
    // Layout reads it to decide whether to apply branded theming.
    const obj = user.toObject();
    const m = obj.merchantId;
    if (m && typeof m === 'object' && m._id) {
      const [logoUrl, cardImageUrl] = await Promise.all([
        presign(m.logo),
        presign(m.cardImage),
      ]);
      obj.merchant = {
        id:             m._id,
        name:           m.name,
        tag:            m.tag,
        titleTag:       m.titleTag,
        type:           m.type,
        primaryColor:   m.primaryColor,
        secondaryColor: m.secondaryColor,
        showPoweredBy:  m.showPoweredBy,
        logoUrl,
        cardImageUrl,
      };
      obj.merchantId = m._id; // keep merchantId as the bare ObjectId, like before
    } else {
      obj.merchant = null;
    }

    res.json({ success: true, user: obj });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /user/profile/password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
