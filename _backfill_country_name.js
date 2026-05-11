require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User = require('./models/User');

const ISO_TO_NAME = {
  AE: 'United Arab Emirates', US: 'United States', GB: 'United Kingdom',
  IN: 'India', SA: 'Saudi Arabia', PK: 'Pakistan', EG: 'Egypt',
  BD: 'Bangladesh', PH: 'Philippines', ID: 'Indonesia', AU: 'Australia',
  CA: 'Canada', DE: 'Germany', FR: 'France', SG: 'Singapore',
  QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman',
  TR: 'Turkey', JP: 'Japan', CN: 'China', ZA: 'South Africa',
  BR: 'Brazil', MX: 'Mexico',
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({
    $or: [
      { countryName: { $in: [null, ''] } },
      { countryName: { $exists: false } },
    ],
    country: { $nin: [null, ''] },
  });

  const NAME_TO_ISO = {};
  for (const [iso, n] of Object.entries(ISO_TO_NAME)) NAME_TO_ISO[n.toLowerCase()] = iso;

  let updated = 0, skipped = 0;
  for (const u of users) {
    const raw = String(u.country).trim();
    let iso = null, name = null;

    if (/^[A-Za-z]{2}$/.test(raw)) {
      iso = raw.toUpperCase();
      name = ISO_TO_NAME[iso];
    } else {
      iso = NAME_TO_ISO[raw.toLowerCase()];
      name = iso ? ISO_TO_NAME[iso] : null;
    }

    if (iso && name) {
      u.country = iso;
      u.countryName = name;
      await u.save();
      console.log(`✓ ${u.email}: "${raw}" → ${iso} / ${name}`);
      updated++;
    } else {
      console.log(`✗ ${u.email}: could not resolve "${raw}" (skipped)`);
      skipped++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  process.exit(0);
})();
