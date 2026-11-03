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
  require('../src/jobs/scheduler');
  console.log('✓ jobs/ loads');
  require('../src/media');
  console.log('✓ media/ loads');
  require('../src/outreach/send-invoice');
  console.log('✓ outreach/ loads');
  require('../src/erp-query/stock');
  console.log('✓ erp-query/stock.js loads');
  require('../src/webhook');
  console.log('✓ webhook.js loads');
  console.log('all good');
  process.exit(0);
} catch (err) {
  console.error('✗ load failed:', err);
  process.exit(1);
}
