import React, { useState, useEffect } from 'react';
import { Shield, Swords, Radar, Clock, TrendingDown, TrendingUp, ChevronRight, Check, Gavel, Lock, ChevronDown, HelpCircle, X, FileText, Target, DollarSign, AlertTriangle, ArrowUp, ArrowDown, Search } from 'lucide-react';

const fmt = (n) => '$' + new Intl.NumberFormat('en-US').format(Math.round(n));
const DISPLAY = { fontFamily: "'Arial Black', Impact, 'Helvetica Neue', sans-serif" };
const bold = { ...DISPLAY, fontWeight: 900 };

const semaphore = (p) => (p < 0.15 ? 'green' : p < 0.4 ? 'yellow' : 'red');
const semColors = {
  green: { bg: 'bg-green-500', text: 'text-green-700', chip: 'bg-green-100 border-green-600' },
  yellow: { bg: 'bg-amber-400', text: 'text-amber-700', chip: 'bg-amber-100 border-amber-500' },
  red: { bg: 'bg-red-600', text: 'text-red-700', chip: 'bg-red-100 border-red-600' },
};

const BS = { cash: 87500, receivables: 30200, assets: 1000000, intangibleAssets: 100000, reserves: 11360, debt: 0 };
const EQUITY = BS.cash + BS.receivables + BS.assets + BS.intangibleAssets + BS.reserves - BS.debt;
const VOLUME = 350, PRICE = 700;
const REVENUE = VOLUME * PRICE;
const SHARES_OUT = 10000;
const LEGAL_EXPOSURE = 6200;
const MARKET_EQUITY = Math.max(0, EQUITY - LEGAL_EXPOSURE);
const STOCK_VALUE = Math.round(MARKET_EQUITY / SHARES_OUT);
const ME = { name: 'Titan AgriCorp', cash: BS.cash, revenue: REVENUE, equity: EQUITY, marketShare: 0.33, outrage: 15, scrutiny: 10, legalExposure: LEGAL_EXPOSURE };
const SCRUTINY_MULTIPLIER = 0.3;
const LEGAL_EXPOSURE_RATIO_CAP = 0.8;
const legalExposureRatio = Math.min(LEGAL_EXPOSURE_RATIO_CAP, ME.legalExposure / ME.cash);
const adjustedProbability = (base) => base * (1 + (SCRUTINY_MULTIPLIER * ME.scrutiny) / 100 + legalExposureRatio);

const CASH_WATERFALL = [
  { label: 'Starting cash', value: 65000, type: 'start' },
  { label: 'Revenue', value: 245000, type: 'plus' },
  { label: 'Cost of goods sold', value: -192500, type: 'minus' },
  { label: 'Operating expenses', value: -20000, type: 'minus' },
  { label: 'Staff costs', value: -10000, type: 'minus' },
  { label: 'Finance cost', value: -5000, type: 'minus' },
  { label: 'Tax', value: -2800, type: 'minus' },
  { label: 'Depreciation (non-cash, added back)', value: 3300, type: 'plus' },
  { label: 'Legal settlement received — Meridian Foods case', value: 4500, type: 'plus' },
];

const SHARE_FACTORS = [
  { label: 'PRICE (LOWER = BETTER)', value: fmt(PRICE) + '/t' },
  { label: 'PROCESSING LEVEL', value: '50%' },
  { label: 'SUPPLY SECURITY', value: '50%' },
  { label: 'PROCESS LOSS (LOWER = BETTER)', value: '10%' },
];
const OUTRAGE_DEMAND_WEIGHT = 0.5;
const MARKETING_DEMAND = 0;
const OUTRAGE_PENALTY = OUTRAGE_DEMAND_WEIGHT * ME.outrage;
const NET_DEMAND = MARKETING_DEMAND - OUTRAGE_PENALTY;

const FULL_REPORT = {
  Finance: [
    ['Cash', fmt(BS.cash)], ['Assets', fmt(BS.assets)], ['Intangible assets', fmt(BS.intangibleAssets)],
    ['Debt', fmt(BS.debt)], ['Equity', fmt(EQUITY)], ['Reserves', fmt(BS.reserves)],
    ['Receivables', fmt(BS.receivables)], ['Revenue', fmt(REVENUE)], ['Operating expenses', fmt(20000)],
    ['Staff cost', fmt(10000)], ['Material cost / ton', fmt(500)], ['Depreciation', fmt(3300)],
    ['Finance cost', fmt(5000)], ['Tax cost', fmt(2800)], ['Other income', fmt(0)],
  ],
  Production: [
    ['Volume', `${VOLUME} t`], ['Price', fmt(PRICE) + '/t'], ['Capacity utilization', '100%'],
    ['Processing level', '50%'], ['Supply security', '50%'], ['Process loss', '10%'], ['Installed capacity', `${VOLUME} t`],
  ],
  Shares: [['Shares outstanding', SHARES_OUT.toLocaleString('en-US')], ['Stock value (legal-discounted)', fmt(STOCK_VALUE)], ['Your ownership', '100%']],
  'Reputation & risk': [['Outrage', '15'], ['Scrutiny', '10'], ['Carbon footprint', '0']],
};

const RIVALS = [
  {
    name: 'Meridian Foods',
    finance: { cash: 62000, revenue: 198000, equity: 890000, debt: 40000, assets: 750000, intangibleAssets: 60000, reserves: 8200, receivables: 24400, operatingExpenses: 22000, staffCost: 12000, materialCostPerTon: 520, depreciation: 4100, financeCost: 6000, taxCost: 3100, otherIncome: 0 },
    historyFull: [{ year: 1, cash: 71000, revenue: 175000, equity: 860000, debt: 55000 }, { year: 2, cash: 68000, revenue: 182000, equity: 875000, debt: 48000 }, { year: 3, cash: 62000, revenue: 198000, equity: 890000, debt: 40000 }],
    reports: [
      { year: 2, text: 'Strategic minority positioning to facilitate unprompted cross-corporate dialogue.' },
      { year: 3, text: 'Executing tactical capital allocations to identify governance optimization opportunities.' },
    ],
  },
  {
    name: 'Nordic Feed Co',
    finance: { cash: 45000, revenue: 210000, equity: 760000, debt: 15000, assets: 640000, intangibleAssets: 40000, reserves: 5100, receivables: 25900, operatingExpenses: 19000, staffCost: 9500, materialCostPerTon: 480, depreciation: 3000, financeCost: 4200, taxCost: 3600, otherIncome: 0 },
    historyFull: [{ year: 1, cash: 58000, revenue: 190000, equity: 740000, debt: 22000 }, { year: 2, cash: 51000, revenue: 205000, equity: 750000, debt: 18000 }, { year: 3, cash: 45000, revenue: 210000, equity: 760000, debt: 15000 }],
    reports: [
      { year: 2, text: 'Optimizing product density to maximize consumer value per unit.' },
      { year: 3, text: 'Innovating formulation science to enhance yield consistency.' },
    ],
  },
];

const GROUNDS = [
  { name: 'Williams Act Disclosure Violation', decision: 'Buy Shares', description: "Sue the competitor for failing to disclose their 5% ownership threshold within the statutory timeline, seeking a freeze on their voting rights." },
  { name: 'Breach of Corporate Fiduciary Duty & Raiding Injunction', decision: 'Buy Shares', description: "Seek an immediate injunction against the competitor; they secretly acquired a significant stake to infiltrate your board, steal insider data, and force a hostile takeover." },
  { name: 'Declaratory Judgment of Patent Invalidity & Unfair Competition', decision: 'Patent Portfolio', description: "File a lawsuit to invalidate the competitor's overly broad patents; their generic claims block your R&D and constitute unfair competition." },
  { name: 'Antitrust Patent Tying & Market Foreclosure Action', decision: 'Patent Portfolio', description: "Sue the competitor for antitrust violations; they are conditioning the license of essential patents on the purchase of unrelated products." },
  { name: 'Defamation Per Se & Tortious Interference with Executive Contract', decision: 'Slander Chief Executive Officer', description: "Sue the competitor for defamation per se and tortious interference; their anonymous smear campaign targeting your CEO tanked your stock price and disrupted executive operations." },
  { name: 'Securities Market Manipulation & Personal Defamation Tort', decision: 'Slander Chief Executive Officer', description: "Sue the competitor for corporate defamation; prove their smear campaign was calculated to trigger a market panic and artificially drop your valuation." },
  { name: 'Sherman Act Section 2 Private Antitrust Litigation', decision: 'Vertical Integration', description: "Sue the competitor for illegal vertical foreclosure and price squeezing; their complete supply chain control is used to deny you critical raw materials and destroy your production." },
  { name: 'Breach of Exclusivity and Supply Poaching Claim', decision: 'Vertical Integration', description: "Sue the competitor for tortious inducement; they coerced your long-term logistics and raw material partners to break existing exclusivity contracts." },
  { name: 'Lanham Act § 43(a) Private Action for Product Weight Fraud', decision: 'Water Pumping', description: "Sue the competitor under the Lanham Act for product weight fraud; they sell water at solid cargo prices, distorting market rates and stealing your contracts and market share." },
  { name: 'Weights and Measures Act Criminal Deception Injunction', decision: 'Water Pumping', description: "Coordinate with consumer groups to sue the competitor for systemic weight fraud, forcing a mandatory product recall across all retail chains." },
  { name: 'Clayton Act Section 4 Private Treble Damages Antitrust Action', decision: 'Raw Material Monopoly', description: "File an antitrust lawsuit for monopoly via exclusive contracts and seek treble damages; the competitor has intentionally blocked your access to critical raw materials and essential inputs." },
  { name: 'Essential Facilities Doctrine Antitrust Litigation', decision: 'Raw Material Monopoly', description: "File an antitrust suit alleging the competitor controls an essential supply facility and refuses to deal, seeking a court-ordered supply mandate." },
];

const CASES = [
  { id: 1, role: 'defendant', opponent: 'Meridian Foods', decision: 'Vertical Integration', ground: 'Breach of Exclusivity & Supply Poaching', description: "Sue the competitor for tortious inducement; they coerced your long-term logistics and raw material partners to break existing exclusivity contracts.", probability: 0.06, stakes: 7350, status: 'negotiating', offers: [], myOffer: null },
  { id: 2, role: 'plaintiff', opponent: 'Nordic Feed Co', decision: 'Water Pumping', ground: 'Lanham Act §43(a) — Product Weight Fraud', description: "Sue the competitor under the Lanham Act for product weight fraud; they sell water at solid cargo prices, distorting market rates and stealing your contracts and market share.", stakes: 42000, status: 'negotiating', offers: [{ by: 'them', amount: 12000 }, { by: 'me', amount: 28000 }], myOffer: 28000 },
  { id: 3, role: 'defendant', opponent: 'Meridian Foods', decision: 'Buy Shares', ground: 'Williams Act Disclosure Violation', description: "Sue the competitor for failing to disclose their 5% ownership threshold within the statutory timeline, seeking a freeze on their voting rights.", probability: 0.32, stakes: 45000, status: 'awaiting_trial', offers: [], myOffer: null },
];

const DESC = {
  'Organic Shift': "Transition your production lines entirely to organic standards. Lowers volume but increases prices and improves public reputation.",
  'New Factory': "Build a new production facility to scale up your long-term output capacity. Increases depreciation and operating expenses.",
  'Aggressive Sale': "Liquidate excess inventory by aggressively cutting prices. Temporarily boosts volume while squeezing profit margins.",
  'Water Pumping': "Artificially pump excess water into final products to increase their weight and boost margins. Serious risk of consumer fraud claims.",
  'Buy Shares': "Purchase a block of another company's shares directly from its capitalization table at the prevailing market price, without requiring the target's consent.",
  'Quality Certification': "Secure an independent quality seal to justify premium pricing and lower public outrage. Cannot be combined with dirty practices.",
  'Vertical Integration': "Acquire or build your own supply chain components to reduce reliance on third-party suppliers and lower material costs.",
};

const DECK = [
  { name: 'Organic Shift', level: 'Strategic', nature: 'Traditional', risk: 0.05, excludedBy: null, maturing: false, effects: { cash: -1, legal: -1 }, preview: 'Year 1: price +10%, processing +10%, capacity -5%, outrage -10. Ramps up over 4 years.' },
  { name: 'New Factory', level: 'Strategic', nature: 'Traditional', risk: 0.0, excludedBy: null, maturing: true, turnsLeft: 2, effects: { cash: -2, legal: 0 }, preview: 'Year 1-2: -$100,000 cash each year. Capacity ramps to +40% by year 3.' },
  { name: 'Aggressive Sale', level: 'Operational', nature: 'Traditional', risk: 0.0, excludedBy: 'Organic Shift', maturing: false, effects: { cash: 1, legal: 0 }, preview: 'This year: price -15%, stock trading volume -30. One-time effect.' },
  { name: 'Water Pumping', level: 'Operational', nature: 'Dirty', risk: 0.45, excludedBy: null, maturing: false, effects: { cash: 1, legal: 2 }, preview: 'This year: capacity +15%, moisture +18%, scrutiny +10. Ongoing while active.' },
  { name: 'Buy Shares', level: 'Strategic', nature: 'Grey Area', risk: 0.1, excludedBy: null, maturing: false, effects: { cash: -1, legal: 1 }, preview: "Cost depends on the stake you choose. Target's operating expenses +15% once purchased." },
  { name: 'Quality Certification', level: 'Operational', nature: 'Traditional', risk: 0.0, excludedBy: null, maturing: false, effects: { cash: -1, legal: -1 }, preview: 'Year 1: -$10,000 intangible investment. Price +8%, outrage -20, scrutiny +10 once matured.' },
];

const MY_ACTIVE = [
  { name: 'Vertical Integration', level: 'Strategic', nature: 'Traditional', matured: true, effects: { cash: -1, legal: 1 } },
  { name: 'New Factory', level: 'Strategic', nature: 'Traditional', matured: false, turnsLeft: 2, effects: { cash: -2, legal: 0 } },
];

const LEVELS = ['All', 'Strategic', 'Operational'];
const NATURES = ['All', 'Traditional', 'Grey Area', 'Dirty'];

function Stamp({ children, tone }) {
  const toneMap = { green: 'border-green-600 text-green-700 bg-green-50', yellow: 'border-amber-500 text-amber-700 bg-amber-50', red: 'border-red-600 text-red-700 bg-red-50', black: 'border-neutral-900 text-neutral-900 bg-white' };
  return <span className={`inline-block border-[3px] rounded px-1.5 py-0.5 text-[10px] tracking-wide -rotate-2 ${toneMap[tone]}`} style={bold}>{children}</span>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div className="bg-white border-[3px] border-neutral-900 rounded-xl max-w-md w-full max-h-[80vh] overflow-y-auto shadow-[6px_6px_0_0_#111]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b-2 border-neutral-900 px-4 py-3 sticky top-0 bg-white">
          <p className="text-sm" style={bold}>{title}</p>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function LineRow({ label, value, tone }) {
  const cls = tone === 'minus' ? 'text-red-600' : tone === 'plus' ? 'text-green-600' : 'text-neutral-900';
  return <div className="flex items-center justify-between text-xs py-1 border-b border-neutral-100"><span className="text-neutral-600">{label}</span><span style={bold} className={cls}>{value}</span></div>;
}

function TotalRow({ label, value }) {
  return <div className="flex items-center justify-between text-sm pt-2 border-t-2 border-neutral-900 mt-1"><span style={bold}>{label}</span><span style={bold}>{value}</span></div>;
}

function CashWaterfallView() {
  let running = 0;
  return <div className="space-y-1">{CASH_WATERFALL.map((row, i) => { running += row.value; return <LineRow key={i} label={row.label} tone={row.type} value={row.type === 'start' ? fmt(row.value) : (row.value >= 0 ? '+' : '') + fmt(row.value)} />; })}<TotalRow label="Cash now" value={fmt(running)} /></div>;
}

function RevenueView() {
  return <div className="space-y-1"><LineRow label="Volume" value={`${VOLUME} t`} /><LineRow label="× Price" value={`${fmt(PRICE)} / t`} /><TotalRow label="Revenue" value={fmt(REVENUE)} /><p className="text-[11px] text-neutral-500 italic mt-2">Volume is set by your market share, capped by installed capacity — see SHARE for the breakdown.</p></div>;
}

function EquityView() {
  return (
    <div className="space-y-1">
      <LineRow label="Cash" value={fmt(BS.cash)} tone="plus" /><LineRow label="Receivables" value={fmt(BS.receivables)} tone="plus" />
      <LineRow label="Assets" value={fmt(BS.assets)} tone="plus" /><LineRow label="Intangible assets" value={fmt(BS.intangibleAssets)} tone="plus" />
      <LineRow label="Reserves" value={fmt(BS.reserves)} tone="plus" /><LineRow label="Debt" value={'-' + fmt(BS.debt)} tone="minus" />
      <TotalRow label="Equity" value={fmt(EQUITY)} />
      <div className="mt-2 pt-2 border-t border-neutral-200">
        <LineRow label="Legal exposure (discount)" value={'-' + fmt(LEGAL_EXPOSURE)} tone="minus" />
        <TotalRow label="Market equity (used for stock price)" value={fmt(MARKET_EQUITY)} />
        <p className="text-[11px] text-neutral-500 italic mt-1.5">Your stock price is priced off market equity, not book equity — open cases against you make your own shares cheaper to buy.</p>
      </div>
    </div>
  );
}

function ShareView() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">{SHARE_FACTORS.map((f) => <div key={f.label} className="bg-neutral-100 border border-neutral-300 rounded px-2 py-1"><p className="text-[9px] text-neutral-500">{f.label}</p><p className="text-xs" style={bold}>{f.value}</p></div>)}</div>
      <div className="bg-neutral-100 border border-neutral-300 rounded px-2 py-2">
        <p className="text-[10px] text-neutral-500 mb-1.5" style={bold}>DEMAND BREAKDOWN</p>
        <LineRow label="Marketing demand" value={`${MARKETING_DEMAND} pts`} />
        <LineRow label={`Outrage penalty (${ME.outrage} × ${OUTRAGE_DEMAND_WEIGHT})`} value={`-${OUTRAGE_PENALTY} pts`} tone="minus" />
        <TotalRow label="Net demand" value={`${NET_DEMAND} pts`} />
        <p className="text-[11px] text-neutral-500 italic mt-1.5">Outrage is currently costing you {OUTRAGE_PENALTY} demand points — dirty moves that spike outrage quietly shrink your market share.</p>
      </div>
      <div className="bg-neutral-100 border border-neutral-300 rounded px-2 py-2">
        <p className="text-[10px] text-neutral-500 mb-1" style={bold}>YOUR SHARE VS 2 RIVALS</p>
        <div className="h-2.5 border border-neutral-900 rounded-full overflow-hidden flex"><div className="h-full bg-red-600" style={{ width: '33%' }} /><div className="h-full bg-neutral-400" style={{ width: '34%' }} /><div className="h-full bg-neutral-300" style={{ width: '33%' }} /></div>
        <p className="text-[11px] text-neutral-500 mt-1">You 33% · Meridian 34% · Nordic 33%</p>
      </div>
      <div className="bg-neutral-100 border border-neutral-300 rounded px-2 py-2 text-xs"><p style={bold} className="mb-1">CAPACITY CAP</p><p className="text-neutral-600 leading-snug">Installed capacity {VOLUME}t × 100% utilization = {VOLUME}t ceiling. Your demand-based share would support more — capacity is the bottleneck this turn.</p></div>
    </div>
  );
}

function ThreatView() {
  const w1 = 0.5, w2 = 0.25, w3 = 0.25;
  const legalTerm = w1 * (legalExposureRatio / LEGAL_EXPOSURE_RATIO_CAP) * 100;
  const scrutinyTerm = w2 * (ME.scrutiny / 100) * 100;
  const outrageTerm = w3 * (ME.outrage / 100) * 100;
  const total = Math.round(legalTerm + scrutinyTerm + outrageTerm);
  return (
    <div className="space-y-1">
      <LineRow label={`Legal exposure ratio (${Math.round(legalExposureRatio * 100)}%, weight 0.5)`} value={legalTerm.toFixed(1)} />
      <LineRow label="Scrutiny (weight 0.25)" value={scrutinyTerm.toFixed(1)} />
      <LineRow label="Outrage (weight 0.25)" value={outrageTerm.toFixed(1)} />
      <TotalRow label="Threat level" value={total} />
      <p className="text-[11px] text-neutral-500 italic mt-2">Legal exposure carries the most weight — it's also the one thing that snowballs, since it makes every open case more likely to succeed too.</p>
    </div>
  );
}

function RiskBreakdownView({ c }) {
  const scrutinyFactor = (SCRUTINY_MULTIPLIER * ME.scrutiny) / 100;
  return (
    <div className="space-y-1">
      <LineRow label="Base probability (this ground)" value={`${Math.round(c.probability * 100)}%`} />
      <LineRow label={`Your scrutiny (${ME.scrutiny})`} value={`+${Math.round(scrutinyFactor * 100)}%`} />
      <LineRow label={`Your legal exposure ratio (capped at 80%)`} value={`+${Math.round(legalExposureRatio * 100)}%`} />
      <TotalRow label="Adjusted probability" value={`${Math.round(adjustedProbability(c.probability) * 100)}%`} />
      <p className="text-[11px] text-neutral-500 italic mt-2">More open cases against you, relative to your cash, make every one of them more likely to succeed — a snowball effect. Settling cases down brings this back.</p>
    </div>
  );
}

function FullReportView() {
  return (
    <div className="space-y-4">
      {Object.entries(FULL_REPORT).map(([group, rows]) => (
        <div key={group}>
          <p className="text-[10px] text-neutral-500 mb-1.5" style={bold}>{group.toUpperCase()}</p>
          <div className="grid grid-cols-2 gap-1.5">{rows.map(([label, value]) => <div key={label} className="bg-neutral-100 border border-neutral-300 rounded px-2 py-1"><p className="text-[10px] text-neutral-500">{label}</p><p className="text-xs" style={bold}>{value}</p></div>)}</div>
        </div>
      ))}
    </div>
  );
}

function RivalFullReportView({ rival }) {
  const f = rival.finance;
  const rows = [
    ['Cash', fmt(f.cash)], ['Revenue', fmt(f.revenue)], ['Equity', fmt(f.equity)], ['Debt', fmt(f.debt)],
    ['Assets', fmt(f.assets)], ['Intangible assets', fmt(f.intangibleAssets)], ['Reserves', fmt(f.reserves)],
    ['Receivables', fmt(f.receivables)], ['Operating expenses', fmt(f.operatingExpenses)], ['Staff cost', fmt(f.staffCost)],
    ['Material cost / ton', fmt(f.materialCostPerTon)], ['Depreciation', fmt(f.depreciation)],
    ['Finance cost', fmt(f.financeCost)], ['Tax cost', fmt(f.taxCost)], ['Other income', fmt(f.otherIncome)],
  ];
  return (
    <div className="space-y-4">
      <div><p className="text-[10px] text-neutral-500 mb-1.5" style={bold}>FINANCIAL STATEMENT</p><div className="grid grid-cols-2 gap-1.5">{rows.map(([label, value]) => <div key={label} className="bg-neutral-100 border border-neutral-300 rounded px-2 py-1"><p className="text-[10px] text-neutral-500">{label}</p><p className="text-xs" style={bold}>{value}</p></div>)}</div></div>
      <div><p className="text-[10px] text-neutral-500 mb-1.5" style={bold}>ANNUAL REPORT</p><div className="space-y-1.5">{rival.reports.map((r, i) => <p key={i} className="text-[11px] text-neutral-600 italic leading-snug">"{r.text}" <span className="text-neutral-400 not-italic">— year {r.year}</span></p>)}</div></div>
      <p className="text-[11px] text-neutral-400 italic">Production-level detail (volume, recipe, processes) isn't visible to rivals — only the official filing above.</p>
    </div>
  );
}

function RivalFieldView({ rival, field }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">{rival.historyFull.map((h) => <div key={h.year} className="flex-1 bg-neutral-100 border border-neutral-300 rounded px-2 py-1.5 text-center"><p className="text-[9px] text-neutral-500">Y{h.year}</p><p className="text-xs" style={bold}>{fmt(h[field])}</p></div>)}</div>
      <p className="text-[11px] text-neutral-500 italic">3-year trend from {rival.name}'s filed statements — no internal cost breakdown is visible.</p>
    </div>
  );
}

function SueModal({ onClose }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const q = query.trim().toLowerCase();
  const results = q === '' ? GROUNDS : GROUNDS.filter((g) => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q));

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] text-neutral-500 mb-1" style={bold}>TARGET</p>
        <select className="w-full border-2 border-neutral-900 rounded px-2 py-1.5 text-sm">{RIVALS.map((r) => <option key={r.name}>{r.name}</option>)}</select>
      </div>

      {!selected && (
        <>
          <div>
            <p className="text-[10px] text-neutral-500 mb-1" style={bold}>SEARCH GROUNDS</p>
            <div className="flex items-center gap-2 border-2 border-neutral-900 rounded px-2 py-1.5">
              <Search size={14} className="text-neutral-400 shrink-0" aria-hidden="true" />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. weight fraud, patent, disclosure…" className="w-full text-sm outline-none" />
            </div>
          </div>
          <p className="text-[10px] text-neutral-500">{results.length} match{results.length === 1 ? '' : 'es'}</p>
          <div className="max-h-56 overflow-y-auto space-y-1.5">
            {results.length === 0 && <p className="text-xs text-neutral-500 italic px-1">No grounds match that search — try different words.</p>}
            {results.map((g) => (
              <button key={g.name} onClick={() => setSelected(g)} className="w-full text-left border-2 border-neutral-900 rounded-lg p-2 hover:bg-neutral-100">
                <p className="text-xs" style={bold}>{g.name}</p>
                <p className="text-[10px] text-neutral-500 mb-1">from {g.decision}</p>
                <p className="text-[11px] text-neutral-600 leading-snug">{g.description}</p>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && (
        <div className="border-2 border-neutral-900 rounded-lg p-2.5 bg-neutral-100">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs" style={bold}>{selected.name}</p>
            <button onClick={() => setSelected(null)} className="text-[10px] underline shrink-0" style={bold}>CHANGE</button>
          </div>
          <p className="text-[10px] text-neutral-500 mb-1">from {selected.decision}</p>
          <p className="text-[11px] text-neutral-600 italic leading-snug">{selected.description}</p>
        </div>
      )}

      <button disabled={!selected} onClick={onClose} className={`w-full py-2 rounded border-2 border-neutral-900 flex items-center justify-center gap-1.5 ${selected ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-neutral-200 text-neutral-400'}`} style={bold}><Gavel size={14} aria-hidden="true" /> FILE SUIT</button>
    </div>
  );
}

function RiskGauge({ value, seconds, onClick }) {
  const pct = Math.max(0, Math.min(100, value));
  const critical = pct >= 70;
  const color = pct < 35 ? 'bg-green-500' : pct < 70 ? 'bg-amber-400' : 'bg-red-600';
  const pulsing = seconds <= 20;
  return (
    <button onClick={onClick} className={`flex items-center gap-3 w-full text-left rounded-lg ${critical ? 'ring-2 ring-red-600 ring-offset-1 p-1 -m-1' : ''}`}>
      <Shield size={20} className="text-neutral-900 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline gap-2 text-[10px] text-neutral-700 mb-1 whitespace-nowrap" style={{ ...bold, letterSpacing: '0.03em' }}><span>{critical ? 'THREAT — ALERT' : 'THREAT LEVEL'}</span><span>{pct}</span></div>
        <div className="h-3 bg-white border-[3px] border-neutral-900 rounded-full overflow-hidden"><div className={`h-full ${color} ${pulsing ? 'animate-pulse' : ''} transition-all`} style={{ width: `${pct}%` }} /></div>
      </div>
      <div className={`flex items-center gap-1 text-sm shrink-0 border-[3px] border-neutral-900 rounded px-2 py-0.5 ${pulsing ? 'bg-red-600 text-white animate-pulse' : 'bg-white text-neutral-900'}`} style={bold}><Clock size={14} aria-hidden="true" />{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</div>
    </button>
  );
}

function EffectChips({ effects }) {
  const chip = (val, Icon, goodIsUp) => {
    if (!val) return null;
    const up = val > 0;
    const good = goodIsUp ? up : !up;
    const Arrow = up ? ArrowUp : ArrowDown;
    return (
      <span className={`inline-flex items-center gap-0.5 border rounded px-1 py-0.5 ${good ? 'text-green-700 border-green-300 bg-green-50' : 'text-red-700 border-red-300 bg-red-50'}`}>
        <Icon size={11} aria-hidden="true" />
        {Array.from({ length: Math.abs(val) }).map((_, i) => <Arrow key={i} size={10} aria-hidden="true" />)}
      </span>
    );
  };
  return <div className="flex items-center gap-1.5 mt-1.5">{chip(effects.cash, DollarSign, true)}{chip(effects.legal, AlertTriangle, false)}</div>;
}

function CaseCard({ c, onInspect, onRiskInfo }) {
  const isDefendant = c.role === 'defendant';
  const displayProbability = isDefendant ? adjustedProbability(c.probability) : c.probability;
  const sem = isDefendant ? semaphore(displayProbability) : null;
  const isFirstOffer = c.offers.length === 0;
  const lastTheirOffer = [...c.offers].reverse().find((o) => o.by === 'them')?.amount ?? Math.round(c.stakes * 0.1);
  const maxOffer = isFirstOffer ? c.stakes : Math.max(...c.offers.map((o) => o.amount));
  const [slider, setSlider] = useState(c.myOffer || lastTheirOffer);
  return (
    <div className="rounded-xl border-[3px] border-neutral-900 bg-white p-3 space-y-2.5 shadow-[4px_4px_0_0_#111]">
      <div className="flex items-start justify-between gap-2">
        <div><Stamp tone="black">{isDefendant ? 'DEFENDANT' : 'PLAINTIFF'}</Stamp><p className="text-sm mt-1" style={bold}>{c.opponent}</p><p className="text-xs text-neutral-600">{c.decision} — {c.ground}</p></div>
        {isDefendant ? (
          <button onClick={() => onRiskInfo(c)} className={`shrink-0 flex items-center gap-1 rounded-full px-2 py-1 border-2 ${semColors[sem].chip}`}><span className={`w-2 h-2 rounded-full ${semColors[sem].bg}`} aria-hidden="true" /><span className={`text-xs ${semColors[sem].text}`} style={bold}>{Math.round(displayProbability * 100)}%</span></button>
        ) : (
          <button onClick={() => onInspect(c.opponent)} className="shrink-0 flex items-center gap-1 text-xs border-2 border-neutral-900 rounded-full px-2 py-1 bg-white hover:bg-neutral-100" style={bold}><HelpCircle size={12} aria-hidden="true" /> INVESTIGATE</button>
        )}
      </div>
      <p className="text-[11px] text-neutral-500 italic leading-snug">{c.description}</p>
      {!isDefendant && <p className="text-[11px] text-neutral-500 leading-snug">Win odds unknown — read {c.opponent}'s filings and press releases to make the call.</p>}
      <div className="flex items-center justify-between text-xs bg-neutral-100 border-2 border-neutral-900 rounded px-2 py-1.5"><span className="text-neutral-600" style={bold}>STAKES</span><span className="text-neutral-900" style={bold}>{fmt(c.stakes)}</span></div>
      {c.status === 'awaiting_trial' ? (
        <div className="flex items-center gap-2 text-xs text-neutral-700 bg-neutral-100 border-2 border-dashed border-neutral-400 rounded px-2 py-2"><Lock size={13} aria-hidden="true" /> Awaiting verdict — resolves when the turn ends</div>
      ) : (
        <>
          {c.offers.length > 0 && <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">{c.offers.map((o, i) => <span key={i} className="text-[11px] text-neutral-700 bg-neutral-100 border border-neutral-400 rounded px-1.5 py-0.5 whitespace-nowrap">{o.by === 'me' ? 'you' : 'them'}: {fmt(o.amount)}</span>)}</div>}
          <div className="border-2 border-neutral-900 rounded-lg p-2 space-y-1.5 bg-neutral-50">
            <p className="text-[10px] text-neutral-500" style={bold}>YOUR COUNTER</p>
            <div className="flex items-center gap-2">
              <input type="range" min={lastTheirOffer} max={maxOffer} step="500" value={slider} onChange={(e) => setSlider(Number(e.target.value))} className="flex-1 accent-red-600" />
              <span className="text-xs w-16 text-right" style={bold}>{fmt(slider)}</span>
            </div>
            <button className="w-full flex items-center justify-center gap-1 text-xs py-1.5 rounded border-2 border-neutral-900 bg-white text-neutral-900 hover:bg-neutral-100" style={bold}>COUNTER AT {fmt(slider)}</button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button className="flex items-center justify-center gap-1 text-xs py-1.5 rounded border-2 border-neutral-900 bg-green-500 text-white hover:bg-green-600" style={bold}><Check size={13} aria-hidden="true" /> ACCEPT {!isFirstOffer && fmt(lastTheirOffer)}</button>
            <button className="flex items-center justify-center gap-1 text-xs py-1.5 rounded border-2 border-neutral-900 bg-red-600 text-white hover:bg-red-700" style={bold}><Swords size={13} aria-hidden="true" /> COURT</button>
          </div>
        </>
      )}
    </div>
  );
}

function KPI({ label, value, trend, onClick }) {
  return (
    <button onClick={onClick} className="text-left bg-white border-2 border-neutral-900 rounded-lg p-2.5 hover:bg-neutral-100">
      <div className="flex items-center justify-between"><p className="text-[10px] text-neutral-600" style={{ ...bold, letterSpacing: '0.02em' }}>{label}</p><FileText size={11} className="text-neutral-400" aria-hidden="true" /></div>
      <div className="flex items-baseline gap-1.5"><p className="text-base" style={bold}>{value}</p>{trend && (trend > 0 ? <TrendingUp size={13} className="text-green-600" aria-hidden="true" /> : <TrendingDown size={13} className="text-red-600" aria-hidden="true" />)}</div>
    </button>
  );
}

function MiniStatButton({ label, value, onClick }) {
  return <button onClick={onClick} className="text-left bg-neutral-100 border border-neutral-400 rounded px-2 py-1.5 hover:bg-neutral-200"><p className="text-[10px] text-neutral-500">{label}</p><span className="text-xs" style={bold}>{value}</span></button>;
}

function RivalDossier({ rival, expanded, onToggle, onFullReport, onFieldClick }) {
  return (
    <div className="border-t-2 border-neutral-200 first:border-0">
      <button onClick={onToggle} className="w-full flex items-center justify-between py-2 text-xs"><span style={bold}>{rival.name}</span><ChevronDown size={14} className={`text-neutral-500 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" /></button>
      {expanded && (
        <div className="pb-2.5 space-y-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            <MiniStatButton label="CASH" value={fmt(rival.finance.cash)} onClick={() => onFieldClick(rival, 'cash', 'CASH')} />
            <MiniStatButton label="REVENUE" value={fmt(rival.finance.revenue)} onClick={() => onFieldClick(rival, 'revenue', 'REVENUE')} />
            <MiniStatButton label="EQUITY" value={fmt(rival.finance.equity)} onClick={() => onFieldClick(rival, 'equity', 'EQUITY')} />
            <MiniStatButton label="DEBT" value={fmt(rival.finance.debt)} onClick={() => onFieldClick(rival, 'debt', 'DEBT')} />
          </div>
          <button onClick={() => onFullReport(rival)} className="w-full text-xs py-1.5 rounded border-2 border-neutral-900 bg-white hover:bg-neutral-100 flex items-center justify-center gap-1.5" style={bold}><FileText size={12} aria-hidden="true" /> FULL FILING</button>
        </div>
      )}
    </div>
  );
}

function ActionCard({ d }) {
  const [confirming, setConfirming] = useState(false);
  const sem = semaphore(d.risk);
  const locked = !!d.excludedBy;
  const blocks = DECK.filter((x) => x.excludedBy === d.name).map((x) => x.name);
  return (
    <div className={`rounded-xl border-[3px] p-2.5 ${locked ? 'border-neutral-300 bg-neutral-50 opacity-60' : 'border-neutral-900 bg-white shadow-[3px_3px_0_0_#111]'}`}>
      <div className="flex items-start justify-between gap-2"><div><p className="text-[10px] text-neutral-500" style={bold}>{d.level.toUpperCase()} · {d.nature.toUpperCase()}</p><p className="text-sm" style={bold}>{d.name}</p></div><span className={`shrink-0 rounded-full w-4 h-4 border-2 border-neutral-900 ${semColors[sem].bg}`} aria-hidden="true" /></div>
      <p className="text-[11px] text-neutral-600 leading-snug mt-1">{DESC[d.name]}</p>
      <EffectChips effects={d.effects} />
      {locked && <p className="text-[11px] text-neutral-500 mt-1.5">Blocked by {d.excludedBy}</p>}
      {d.maturing && <p className="text-[11px] text-amber-600 mt-1.5">Matures in {d.turnsLeft} years</p>}
      {!locked && blocks.length > 0 && <p className="text-[11px] text-amber-600 mt-1.5">Will block: {blocks.join(', ')}</p>}
      {!locked && !confirming && <button onClick={() => setConfirming(true)} className="mt-2 w-full text-xs py-1.5 rounded border-2 border-neutral-900 bg-white hover:bg-neutral-100 flex items-center justify-center gap-1" style={bold}>DEPLOY <ChevronRight size={13} aria-hidden="true" /></button>}
      {!locked && confirming && (
        <div className="mt-2 space-y-1.5 bg-neutral-100 border-2 border-neutral-900 rounded p-2">
          <p className="text-[11px] text-neutral-600 leading-snug">{d.preview}</p>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setConfirming(false)} className="text-xs py-1.5 rounded border-2 border-neutral-900 bg-white hover:bg-neutral-100" style={bold}>CANCEL</button>
            <button onClick={() => setConfirming(false)} className="text-xs py-1.5 rounded border-2 border-neutral-900 bg-red-600 text-white hover:bg-red-700" style={bold}>CONFIRM</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveCard({ d }) {
  return (
    <div className="rounded-xl border-[3px] border-neutral-900 bg-white p-2.5 shadow-[3px_3px_0_0_#111]">
      <div className="flex items-start justify-between gap-2">
        <div><p className="text-[10px] text-neutral-500" style={bold}>{d.level.toUpperCase()} · {d.nature.toUpperCase()}</p><p className="text-sm" style={bold}>{d.name}</p></div>
        <Stamp tone={d.matured ? 'green' : 'yellow'}>{d.matured ? 'MATURED' : `${d.turnsLeft}T LEFT`}</Stamp>
      </div>
      <p className="text-[11px] text-neutral-600 leading-snug mt-1">{DESC[d.name]}</p>
      <EffectChips effects={d.effects} />
    </div>
  );
}

function FilterChips({ options, value, onChange }) {
  return <div className="flex gap-1 flex-wrap">{options.map((o) => <button key={o} onClick={() => onChange(o)} className={`text-[10px] px-2 py-1 rounded-full border-2 ${value === o ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-600 border-neutral-300'}`} style={bold}>{o.toUpperCase()}</button>)}</div>;
}

function IntelPanel({ expandedRival, setExpandedRival, setDrillDown }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <KPI label="CASH" value={fmt(ME.cash)} trend={1} onClick={() => setDrillDown({ kind: 'cash' })} />
        <KPI label="REVENUE" value={fmt(ME.revenue)} trend={1} onClick={() => setDrillDown({ kind: 'revenue' })} />
        <KPI label="SHARE" value={`${Math.round(ME.marketShare * 100)}%`} onClick={() => setDrillDown({ kind: 'share' })} />
        <KPI label="EQUITY" value={fmt(ME.equity)} onClick={() => setDrillDown({ kind: 'equity' })} />
      </div>
      <button onClick={() => setDrillDown({ kind: 'full' })} className="w-full text-xs py-2 rounded-lg border-2 border-neutral-900 bg-white hover:bg-neutral-100 flex items-center justify-center gap-1.5" style={bold}><FileText size={13} aria-hidden="true" /> FULL COMPANY REPORT</button>
      <div className="bg-white border-2 border-neutral-900 rounded-lg p-2.5">
        <p className="text-[10px] text-neutral-600 mb-1" style={bold}>RIVALS</p>
        {RIVALS.map((rival) => <RivalDossier key={rival.name} rival={rival} expanded={expandedRival === rival.name} onToggle={() => setExpandedRival(expandedRival === rival.name ? null : rival.name)} onFullReport={(r) => setDrillDown({ kind: 'rival', rival: r })} onFieldClick={(r, field, label) => setDrillDown({ kind: 'rivalField', rival: r, field, label })} />)}
      </div>
    </>
  );
}

export default function WarRoomDashboard() {
  const [seconds, setSeconds] = useState(97);
  const [mobileTab, setMobileTab] = useState('litigation');
  const [deckTab, setDeckTab] = useState('new');
  const [expandedRival, setExpandedRival] = useState(null);
  const [drillDown, setDrillDown] = useState(null);
  const [levelFilter, setLevelFilter] = useState('All');
  const [natureFilter, setNatureFilter] = useState('All');

  useEffect(() => { const t = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 120)), 1000); return () => clearInterval(t); }, []);

  const openDefendantCases = CASES.filter((c) => c.role === 'defendant').length;
  const riskValue = Math.min(100, ME.outrage + ME.scrutiny + openDefendantCases * 15);
  const inspect = (name) => { setExpandedRival(name); setMobileTab('intel'); };
  const tabs = [{ id: 'intel', label: 'INTEL', icon: Radar }, { id: 'litigation', label: 'COURT', icon: Swords }, { id: 'command', label: 'MOVES', icon: Target }];

  const filteredDeck = DECK.filter((d) => (levelFilter === 'All' || d.level === levelFilter) && (natureFilter === 'All' || d.nature === natureFilter));
  const maturing = MY_ACTIVE.filter((d) => !d.matured);
  const matured = MY_ACTIVE.filter((d) => d.matured);

  const modalTitles = { cash: 'CASH — SINCE LAST TURN', revenue: 'REVENUE — THIS TURN', share: 'MARKET SHARE — HOW IT WORKS', equity: 'EQUITY — BALANCE SHEET', full: 'FULL COMPANY REPORT', rival: drillDown?.rival ? `${drillDown.rival.name} — FULL FILING` : '', rivalField: drillDown?.rival ? `${drillDown.rival.name} — ${drillDown.label}` : '', sue: 'SUE THEIR ASSES', threat: 'THREAT LEVEL — BREAKDOWN', risk: drillDown?.case ? `${drillDown.case.opponent} — RISK BREAKDOWN` : '' };

  const MovesContent = (
    <>
      <div className="flex gap-1 bg-white border-2 border-neutral-900 rounded-lg p-1">
        {['new', 'current'].map((t) => <button key={t} onClick={() => setDeckTab(t)} className={`flex-1 text-xs py-1.5 rounded ${deckTab === t ? 'bg-red-600 text-white' : 'text-neutral-500'}`} style={bold}>{t === 'new' ? 'NEW MOVE' : 'CURRENT MOVES'}</button>)}
      </div>
      {deckTab === 'new' && (
        <>
          <div className="text-[11px] text-neutral-600 px-1" style={bold}>1 STRATEGIC · 2 OPS LEFT</div>
          <div className="flex items-center gap-1.5 px-1"><Search size={12} className="text-neutral-400" aria-hidden="true" /><span className="text-[10px] text-neutral-400" style={bold}>FILTER</span></div>
          <FilterChips options={LEVELS} value={levelFilter} onChange={setLevelFilter} />
          <FilterChips options={NATURES} value={natureFilter} onChange={setNatureFilter} />
          <div className="space-y-2">{filteredDeck.map((d) => <ActionCard key={d.name} d={d} />)}</div>
        </>
      )}
      {deckTab === 'current' && (
        <>
          {maturing.length > 0 && <p className="text-[10px] text-neutral-500 px-1" style={bold}>STILL RAMPING</p>}
          <div className="space-y-2">{maturing.map((d) => <ActiveCard key={d.name} d={d} />)}</div>
          {matured.length > 0 && <p className="text-[10px] text-neutral-500 px-1 mt-1" style={bold}>MATURED</p>}
          <div className="space-y-2">{matured.map((d) => <ActiveCard key={d.name} d={d} />)}</div>
        </>
      )}
    </>
  );

  const CourtContent = (
    <>
      <button onClick={() => setDrillDown({ kind: 'sue' })} className="w-full py-3 rounded-xl border-[3px] border-neutral-900 bg-red-600 text-white shadow-[4px_4px_0_0_#111] hover:bg-red-700 flex items-center justify-center gap-2 text-sm" style={bold}><Gavel size={16} aria-hidden="true" /> SUE THEIR ASSES</button>
      <p className="text-[11px] text-neutral-500 italic px-1">You always see your own risk. Suing someone else? You'll need to read their filings first — no percentage is handed to you.</p>
      {CASES.map((c) => <CaseCard key={c.id} c={c} onInspect={inspect} onRiskInfo={(cs) => setDrillDown({ kind: 'risk', case: cs })} />)}
    </>
  );

  return (
    <div className="bg-neutral-50 text-neutral-900 rounded-xl overflow-hidden max-w-full" style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
      <h2 className="sr-only">Sue Their Asses — War Room dashboard with risk gauge, court cases, rival intel, filterable strategic moves and full financial drill-downs</h2>

      <div className="border-b-[3px] border-neutral-900 bg-white">
        <div className="px-3 py-2 flex items-center justify-between gap-3">
          <div><p className="text-sm" style={bold}>{ME.name}</p><p className="text-[10px] text-neutral-500">YEAR 3 · 3 PLAYERS</p></div>
          <div className="w-40 sm:w-56"><RiskGauge value={riskValue} seconds={seconds} onClick={() => setDrillDown({ kind: 'threat' })} /></div>
        </div>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-neutral-500 shrink-0" style={bold}>EXPOSURE</span>
            <div className="flex-1 h-2 bg-neutral-200 border border-neutral-900 rounded-full overflow-hidden"><div className="h-full bg-red-600" style={{ width: `${Math.min(100, (ME.legalExposure / ME.cash) * 100)}%` }} /></div>
          </div>
          <p className="text-[10px] text-neutral-500 mt-0.5">{fmt(ME.legalExposure)} at risk across {openDefendantCases} open cases · {fmt(ME.cash)} cash on hand</p>
        </div>
      </div>

      <div className="hidden md:grid md:grid-cols-[1fr_1.3fr_1fr] gap-3 p-3">
        <div className="space-y-3"><IntelPanel expandedRival={expandedRival} setExpandedRival={setExpandedRival} setDrillDown={setDrillDown} /></div>
        <div className="space-y-3">{CourtContent}</div>
        <div className="space-y-3">{MovesContent}</div>
      </div>

      <div className="md:hidden p-3 pb-16 space-y-3">
        {mobileTab === 'intel' && (
          <>
            {expandedRival && <button onClick={() => setMobileTab('litigation')} className="w-full text-xs py-2 rounded-lg border-2 border-neutral-900 bg-amber-50 flex items-center justify-center gap-1.5" style={bold}><ChevronRight size={13} className="rotate-180" aria-hidden="true" /> BACK TO COURT</button>}
            <IntelPanel expandedRival={expandedRival} setExpandedRival={setExpandedRival} setDrillDown={setDrillDown} />
          </>
        )}
        {mobileTab === 'litigation' && CourtContent}
        {mobileTab === 'command' && MovesContent}
      </div>

      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t-[3px] border-neutral-900 flex" style={{ position: 'sticky' }}>
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setMobileTab(id)} className={`flex-1 flex flex-col items-center gap-0.5 py-2 ${mobileTab === id ? 'text-red-600' : 'text-neutral-400'}`}><Icon size={18} aria-hidden="true" /><span className="text-[10px]" style={bold}>{label}</span></button>)}
      </div>

      {drillDown && (
        <Modal title={modalTitles[drillDown.kind]} onClose={() => setDrillDown(null)}>
          {drillDown.kind === 'cash' && <CashWaterfallView />}
          {drillDown.kind === 'revenue' && <RevenueView />}
          {drillDown.kind === 'share' && <ShareView />}
          {drillDown.kind === 'equity' && <EquityView />}
          {drillDown.kind === 'threat' && <ThreatView />}
          {drillDown.kind === 'full' && <FullReportView />}
          {drillDown.kind === 'rival' && <RivalFullReportView rival={drillDown.rival} />}
          {drillDown.kind === 'rivalField' && <RivalFieldView rival={drillDown.rival} field={drillDown.field} />}
          {drillDown.kind === 'sue' && <SueModal onClose={() => setDrillDown(null)} />}
          {drillDown.kind === 'risk' && <RiskBreakdownView c={drillDown.case} />}
        </Modal>
      )}
    </div>
  );
}
