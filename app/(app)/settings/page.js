/**
 * /settings — read-only profile + business info + WhatsApp connection hint.
 * Editing comes later (it's a thin wrapper over ERPNext + the users table).
 */

import { getAppContext } from '../_lib/context';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import LogoutButton from '../_components/LogoutButton';

export const dynamic = 'force-dynamic';

function getBotWhatsAppNumber() {
  const env = process.env.TWILIO_ENV || 'sandbox';
  const raw =
    env === 'live'
      ? process.env.TWILIO_WHATSAPP_NUMBER_LIVE
      : process.env.TWILIO_WHATSAPP_NUMBER_SANDBOX || process.env.TWILIO_WHATSAPP_NUMBER;
  return raw ? raw.replace(/^whatsapp:/i, '') : null;
}

export default async function SettingsPage() {
  const { user } = await getAppContext();
  const botNumber = getBotWhatsAppNumber();
  const isSandbox = (process.env.TWILIO_ENV || 'sandbox') !== 'live';

  return (
    <>
      <PageHeader title="Settings" subtitle="Your profile and how to reach the bot." />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Profile">
          <dl className="text-sm space-y-2">
            <Row label="Name" value={user.display_name} />
            <Row label="Email" value={user.email} />
            <Row label="WhatsApp" value={user.phone} />
          </dl>
        </Card>

        <Card title="Business">
          <dl className="text-sm space-y-2">
            <Row label="Company" value={user.erpnext_company} />
            <Row label="Type" value={prettyBusinessType(user.business_type)} />
            <Row label="Entity" value={prettyEntityType(user.entity_type)} />
            <Row label="Nature" value={user.nature_of_business} />
            <Row label="Country" value={user.country} />
            <Row label="Default currency" value={user.default_currency} />
            <Row label="Tax ID" value={user.tax_id} />
          </dl>
        </Card>

        {(user.address_line1 || user.city || user.postal_code) && (
          <Card title="Address" className="lg:col-span-2">
            <address className="text-sm not-italic text-slate-800 leading-relaxed">
              {user.address_line1 && <div>{user.address_line1}</div>}
              {user.address_line2 && <div>{user.address_line2}</div>}
              <div>
                {[user.city, user.state_province, user.postal_code].filter(Boolean).join(', ')}
              </div>
              {user.country && <div className="text-slate-500">{user.country}</div>}
            </address>
          </Card>
        )}

        <Card title="WhatsApp bot" className="lg:col-span-2">
          {botNumber ? (
            <>
              <p className="text-sm text-slate-700">
                Message the bot at <strong className="font-mono">{botNumber}</strong> on WhatsApp.
                Try things like <em>“sold pa2293 to tall mike for 1400 usd”</em> or <em>“cash balance”</em>.
              </p>
              {isSandbox && (
                <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-900">
                  <strong>Sandbox mode.</strong> If you haven&rsquo;t already, message the join code
                  (Twilio Console → Messaging → Try it out → WhatsApp) to <code className="font-mono">{botNumber}</code> first,
                  otherwise the bot&rsquo;s replies will be silently dropped.
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--color-ink-muted)]">
              The bot WhatsApp number isn&rsquo;t configured. Set
              <code className="font-mono"> TWILIO_WHATSAPP_NUMBER_SANDBOX</code> in <code>.env</code>.
            </p>
          )}
        </Card>

        <Card title="Sign out" className="lg:col-span-2">
          <p className="text-sm text-[var(--color-ink-muted)] mb-3">
            Sign out of this browser. Your data and the bot stay running.
          </p>
          <div className="max-w-[160px]">
            <LogoutButton />
          </div>
        </Card>
      </div>
    </>
  );
}

function prettyBusinessType(t) {
  return t === 'service' ? 'Service' : t === 'product' ? 'Physical product' : t === 'both' ? 'Both' : null;
}
function prettyEntityType(t) {
  return t === 'individual' ? 'Individual' : t === 'company' ? 'Company' : null;
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="text-right text-slate-900">{value || <span className="text-slate-300">—</span>}</dd>
    </div>
  );
}
