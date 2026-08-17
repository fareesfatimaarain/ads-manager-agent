import { useCallback, useEffect, useState } from 'react';
import { fetchOperations, money } from './api';
import {
  createBrief,
  fetchBriefs,
  generateReviews,
  launchBrief,
  type CampaignBrief,
  type ReviewItem,
} from './governanceApi';
import { EmptyState } from './components';

const CAMPAIGN_TYPES: { value: CampaignBrief['campaignType']; label: string }[] = [
  { value: 'conversion', label: 'Conversion — move a ready buyer to act' },
  { value: 'awareness', label: 'Awareness — introduce the brand' },
  { value: 'retargeting', label: 'Retargeting — re-engage people who already looked' },
  { value: 'launch', label: 'Launch — announce something new' },
  { value: 'seasonal', label: 'Seasonal — tied to a moment in time' },
];

interface Account {
  id: string;
  name: string;
  platform: string;
  status: string;
}

/**
 * Everything a client needs to go from "nothing exists" to "an approved batch of creative is
 * live" without leaving the review tab: define what the campaign is for, generate creative
 * against it, then launch whatever clears review. Each brief tracks its own campaign once
 * launched, so approving and launching a second batch later extends the same test.
 */
export function CampaignsPanel({
  reviews,
  onChanged,
  busy,
  setBusy,
}: {
  reviews: ReviewItem[];
  onChanged: () => void | Promise<void>;
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const [briefs, setBriefs] = useState<CampaignBrief[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBriefs = useCallback(async () => {
    setBriefs((await fetchBriefs()).briefs);
  }, []);

  useEffect(() => {
    void loadBriefs();
    void fetchOperations()
      .then((o) => setAccounts(o.accounts))
      .catch(() => setAccounts([]));
  }, [loadBriefs]);

  const refresh = async () => {
    await loadBriefs();
    await onChanged();
  };

  if (!briefs) return <EmptyState title="Loading campaigns" body="One moment." />;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="variant">
        <div>
          <div className="variant-headline">Campaigns</div>
          <div className="variant-body">
            A campaign is what creative is generated for and what it launches into. Create one,
            generate creative against it, then launch whatever comes out of review.
          </div>
        </div>
        <button className="btn btn--primary" disabled={creating} onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ New campaign'}
        </button>
      </div>

      {error ? <div className="notice notice--bad">{error}</div> : null}

      {creating ? (
        <NewBriefForm
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
          onError={setError}
        />
      ) : null}

      {briefs.length === 0 && !creating ? (
        <div className="notice" style={{ marginTop: 12 }}>
          No campaigns yet. Create one to generate creative against a stated audience, offer, and
          landing page — creative generated with no destination can never be launched.
        </div>
      ) : (
        briefs.map((brief) => (
          <BriefRow
            key={brief.id}
            brief={brief}
            accounts={accounts ?? []}
            approvedUnlaunched={reviews.filter(
              (r) => r.campaignBriefId === brief.id && r.status === 'APPROVED' && !r.launchedAt,
            ).length}
            busy={busy}
            setBusy={setBusy}
            onChanged={refresh}
            setError={setError}
          />
        ))
      )}
    </div>
  );
}

function NewBriefForm({
  onCreated,
  onError,
}: {
  onCreated: () => void | Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [campaignType, setCampaignType] = useState<CampaignBrief['campaignType']>('conversion');
  const [landingPageUrl, setLandingPageUrl] = useState('');
  const [variantCount, setVariantCount] = useState(4);
  const [budget, setBudget] = useState('30.00');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    onError(null);
    if (!name.trim()) return onError('Give the campaign a name.');
    if (!/^https?:\/\//.test(landingPageUrl)) return onError('Landing page must be a full URL, starting with http(s)://');
    const cents = Math.round(Number(budget) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return onError('Daily budget per variant must be a positive amount.');

    setSaving(true);
    try {
      await createBrief({
        name: name.trim(),
        campaignType,
        landingPageUrl,
        variantCount,
        dailyBudgetPerVariantCents: cents,
        placements: [{ platform: 'META', formats: ['FEED_1_1'] }],
      });
      await onCreated();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)' }}>
      <div className="field-row">
        <div className="field-label"><label>Name</label></div>
        <div className="field-input">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 prospecting — cold audience" />
        </div>
      </div>
      <div className="field-row">
        <div className="field-label"><label>What this campaign is for</label></div>
        <div className="field-input">
          <select className="input" value={campaignType} onChange={(e) => setCampaignType(e.target.value as CampaignBrief['campaignType'])}>
            {CAMPAIGN_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field-label">
          <label>Landing page</label>
          <div className="field-help">Where the ad sends people who click.</div>
        </div>
        <div className="field-input">
          <input className="input" value={landingPageUrl} onChange={(e) => setLandingPageUrl(e.target.value)} placeholder="https://example.com/offer" />
        </div>
      </div>
      <div className="field-row">
        <div className="field-label">
          <label>Variants to generate</label>
          <div className="field-help">Different creative angles tested against each other.</div>
        </div>
        <div className="field-input">
          <input className="input" type="number" min={1} max={20} value={variantCount} onChange={(e) => setVariantCount(Number(e.target.value))} />
        </div>
      </div>
      <div className="field-row">
        <div className="field-label">
          <label>Daily budget per variant</label>
          <div className="field-help">What each variant spends per day once launched, before any autonomous change.</div>
        </div>
        <div className="field-input">
          <span className="field-prefix">$</span>
          <input className="input" type="number" step="0.01" min="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
      </div>
      <div className="actions">
        <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Creating…' : 'Create campaign'}
        </button>
      </div>
    </div>
  );
}

function BriefRow({
  brief,
  accounts,
  approvedUnlaunched,
  busy,
  setBusy,
  onChanged,
  setError,
}: {
  brief: CampaignBrief;
  accounts: Account[];
  approvedUnlaunched: number;
  busy: string | null;
  setBusy: (v: string | null) => void;
  onChanged: () => void | Promise<void>;
  setError: (e: string | null) => void;
}) {
  const [launching, setLaunching] = useState(false);
  const busyKey = `brief:${brief.id}`;
  const isBusy = busy === busyKey;

  const generate = async () => {
    setBusy(busyKey);
    setError(null);
    try {
      await generateReviews({ campaignBriefId: brief.id, variantCount: brief.variantCount });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="review-card" style={{ marginTop: 12 }}>
      <div className="variant">
        <div>
          <div className="variant-headline">{brief.name}</div>
          <div className="variant-body">
            {CAMPAIGN_TYPES.find((t) => t.value === brief.campaignType)?.label ?? brief.campaignType}
            {' · '}{money(brief.dailyBudgetPerVariantCents)}/day per variant × {brief.variantCount}
            {brief.launchedCampaignId ? ' · already live — launching again extends this test' : ' · not launched yet'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={isBusy} onClick={() => void generate()}>
            {isBusy ? 'Generating…' : 'Generate creative'}
          </button>
          <button
            className="btn btn--primary"
            disabled={approvedUnlaunched === 0}
            title={approvedUnlaunched === 0 ? 'Approve at least one item from this campaign first' : undefined}
            onClick={() => setLaunching((v) => !v)}
          >
            {launching ? 'Cancel' : `Launch (${approvedUnlaunched} ready)`}
          </button>
        </div>
      </div>

      {launching ? (
        <LaunchForm
          brief={brief}
          accounts={accounts}
          onDone={async () => {
            setLaunching(false);
            await onChanged();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function LaunchForm({
  brief,
  accounts,
  onDone,
  onError,
}: {
  brief: CampaignBrief;
  accounts: Account[];
  onDone: () => void | Promise<void>;
  onError: (e: string | null) => void;
}) {
  const usable = accounts.filter((a) => a.status === 'ACTIVE');
  const [adAccountId, setAdAccountId] = useState(usable[0]?.id ?? '');
  const [countries, setCountries] = useState('US');
  const [cohortName, setCohortName] = useState(`${brief.name} — batch ${new Date().toISOString().slice(0, 10)}`);
  const [startPaused, setStartPaused] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    onError(null);
    if (!adAccountId) return onError('Connect an active ad account before launching.');
    const countryList = countries.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (countryList.length === 0) return onError('List at least one country code, e.g. US.');

    setSaving(true);
    try {
      await launchBrief(brief.id, {
        adAccountId,
        campaignName: brief.name,
        cohortName,
        targeting: { countries: countryList },
        startPaused,
      });
      await onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)' }}>
      {usable.length === 0 ? (
        <div className="notice notice--bad">
          No active ad account is connected. Connect one in Operations before launching.
        </div>
      ) : (
        <>
          <div className="field-row">
            <div className="field-label"><label>Ad account</label></div>
            <div className="field-input">
              <select className="input" value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)}>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.platform})</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field-label">
              <label>Countries</label>
              <div className="field-help">Comma-separated country codes.</div>
            </div>
            <div className="field-input">
              <input className="input" value={countries} onChange={(e) => setCountries(e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field-label"><label>Batch name</label></div>
            <div className="field-input">
              <input className="input" value={cohortName} onChange={(e) => setCohortName(e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field-label">
              <label>Start paused</label>
              <div className="field-help">
                Recommended — creates everything on the platform without spending, so you can
                eyeball it before it goes live.
              </div>
            </div>
            <div className="field-input">
              <input type="checkbox" checked={startPaused} onChange={(e) => setStartPaused(e.target.checked)} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
              {saving ? 'Launching…' : startPaused ? 'Create, paused' : 'Launch live'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
