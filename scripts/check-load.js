// Quick smoke test: verify all bot modules load without syntax / import errors.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
try {
  require('../src/conversation');
  console.log('✓ conversation.js loads');
  require('../src/whatsapp');
  console.log('✓ whatsapp.js loads');
  require('../src/erpnext');
  console.log('✓ erpnext.js loads');
  require('../src/tools');
  console.log('✓ tools/ loads');
  require('../src/erp-sync');
  console.log('✓ erp-sync/ loads');
  console.log('all good');
  process.exit(0);
} catch (err) {
  console.error('✗ load failed:', err);
  process.exit(1);
}
