// Design tokens — Bitcoin Standard app
// Bitcoin orange is a generic public-domain color, not a copyrighted brand element.

const BTC_ORANGE = '#F7931A';
const BTC_ORANGE_DEEP = '#E07B0E';
const BTC_ORANGE_GLOW = 'rgba(247,147,26,0.18)';

const TOKENS = {
  light: {
    bg: '#FAF8F4',
    surface: '#FFFFFF',
    surface2: '#F4F1EB',
    elevated: '#FFFFFF',
    border: 'rgba(20,16,10,0.08)',
    borderStrong: 'rgba(20,16,10,0.14)',
    text: '#15110A',
    textMuted: 'rgba(21,17,10,0.58)',
    textFaint: 'rgba(21,17,10,0.38)',
    accent: BTC_ORANGE,
    accentDeep: BTC_ORANGE_DEEP,
    accentSoft: 'rgba(247,147,26,0.12)',
    accentSoft2: 'rgba(247,147,26,0.22)',
    success: '#1B7A3E',
    successSoft: 'rgba(27,122,62,0.14)',
    warn:    '#B8860B',
    warnSoft: 'rgba(184,134,11,0.16)',
    danger: '#C0392B',
    dangerSoft: 'rgba(192,57,43,0.14)',
    info:   '#2C6E8F',
    infoSoft: 'rgba(44,110,143,0.14)',
    plum:   '#7A4F8A',
    plumSoft: 'rgba(122,79,138,0.14)',
    chartGrid: 'rgba(20,16,10,0.06)',
  },
  dark: {
    bg: '#0B0907',
    surface: '#15120E',
    surface2: '#1C1813',
    elevated: '#211C16',
    border: 'rgba(255,236,200,0.08)',
    borderStrong: 'rgba(255,236,200,0.14)',
    text: '#F4ECD8',
    textMuted: 'rgba(244,236,216,0.62)',
    textFaint: 'rgba(244,236,216,0.38)',
    accent: BTC_ORANGE,
    accentDeep: '#FFB347',
    accentSoft: 'rgba(247,147,26,0.16)',
    accentSoft2: 'rgba(247,147,26,0.28)',
    success: '#4ADE80',
    successSoft: 'rgba(74,222,128,0.18)',
    warn:    '#F2C94C',
    warnSoft: 'rgba(242,201,76,0.18)',
    danger: '#F87171',
    dangerSoft: 'rgba(248,113,113,0.18)',
    info:   '#7AC4E5',
    infoSoft: 'rgba(122,196,229,0.16)',
    plum:   '#C9A0DC',
    plumSoft: 'rgba(201,160,220,0.16)',
    chartGrid: 'rgba(255,236,200,0.05)',
  },
};

// Mock data — fictional Bitcoin holder
const SEED = {
  net: { btc: 4.21847, change30d: 0.082, costBasis: 178420, athBtc: 4.36120, athDate: 'Apr 14, 2026' },
  price: 94250, // USD/BTC, used only for sat math display? we keep BTC standard.
  // Recurring bills — single source of truth for both todos AND transactions.
  // Each bill auto-spawns a todo on its day-of-month and a pre-staged txn.
  bills: [
    { id: 'b1', name: 'Apartment Rent', cat: 'rent',   sats: 4500000, day: 1,  method: 'On-chain',  paidThisCycle: true,  satsLastYear: 6210000 },
    { id: 'b2', name: 'Starlink',       cat: 'energy', sats: 118000,  day: 6,  method: 'Lightning', paidThisCycle: true,  satsLastYear: 168000  },
    { id: 'b3', name: 'Cursor Pro',     cat: 'tools',  sats: 41200,   day: 30, method: 'Lightning', paidThisCycle: false, satsLastYear: 58000   },
    { id: 'b4', name: 'Spotify Family', cat: 'tools',  sats: 18400,   day: 12, method: 'Lightning', paidThisCycle: false, satsLastYear: 24600   },
    { id: 'b5', name: 'Gym',            cat: 'health', sats: 56000,   day: 15, method: 'Lightning', paidThisCycle: false, satsLastYear: 78400   },
    { id: 'b6', name: 'iCloud Storage', cat: 'tools',  sats:  3200,   day: 22, method: 'Lightning', paidThisCycle: false, satsLastYear:  4520   },
  ],
  // Cost-basis lots (FIFO). Cold storage acquired progressively over years.
  lots: [
    { id: 'L1', date: 'Mar 2021', sats:  82_000_000, basisUsd: 38900, label: 'Initial buy' },
    { id: 'L2', date: 'Jul 2022', sats:  64_000_000, basisUsd: 13800, label: 'Drawdown DCA' },
    { id: 'L3', date: 'Feb 2023', sats:  52_000_000, basisUsd: 12100, label: 'DCA' },
    { id: 'L4', date: 'Nov 2023', sats:  48_000_000, basisUsd: 17600, label: 'DCA' },
    { id: 'L5', date: 'Jun 2024', sats:  41_000_000, basisUsd: 26800, label: 'Bonus → cold' },
    { id: 'L6', date: 'Jan 2025', sats:  38_000_000, basisUsd: 36400, label: 'DCA' },
    { id: 'L7', date: '2025–26',  sats:  96_847_000, basisUsd: 78420, label: 'Weekly DCA' },
  ],
  today: '2026-05-08',
  // Budget categories — limits in sats per month
  categories: [
    { id: 'food',    name: 'Food & Groceries', limit: 1200000, spent: 842000, color: '#F7931A', glyph: 'fork' },
    { id: 'rent',    name: 'Housing',          limit: 4500000, spent: 4500000, color: '#E07B0E', glyph: 'home' },
    { id: 'travel',  name: 'Travel',           limit: 2000000, spent: 318000, color: '#FFB347', glyph: 'plane' },
    { id: 'health',  name: 'Health',           limit: 600000,  spent: 124000, color: '#C97014', glyph: 'heart' },
    { id: 'energy',  name: 'Energy & Utilities', limit: 800000, spent: 612000, color: '#A55B0F', glyph: 'bolt' },
    { id: 'tools',   name: 'Tools & Software', limit: 500000,  spent: 478000, color: '#F7931A', glyph: 'wrench' },
    { id: 'gifts',   name: 'Gifts & Giving',   limit: 400000,  spent: 80000,  color: '#FFB347', glyph: 'gift' },
  ],
  txns: [
    { id: 't1', merchant: 'Steak n Shake',     cat: 'food',   sats: -38400, when: 'Today, 1:24 PM',  method: 'Lightning' },
    { id: 't2', merchant: 'Salary — Northwind',cat: 'income', sats: 12400000, when: 'Today, 9:02 AM',  method: 'On-chain', income: true },
    { id: 't3', merchant: 'Strike DCA',        cat: 'dca',    sats: -2100000, when: 'Yesterday',       method: 'On-chain', dca: true },
    { id: 't4', merchant: 'Starlink',          cat: 'energy', sats: -118000, when: 'May 6',            method: 'Lightning' },
    { id: 't5', merchant: 'Whole Foods',       cat: 'food',   sats: -64200,  when: 'May 6',            method: 'Lightning' },
    { id: 't6', merchant: 'Delta Airlines',    cat: 'travel', sats: -318000, when: 'May 5',            method: 'Lightning' },
    { id: 't7', merchant: 'Pharmacy',          cat: 'health', sats: -22400,  when: 'May 5',            method: 'Lightning' },
    { id: 't8', merchant: 'Apartment Rent',    cat: 'rent',   sats: -4500000, when: 'May 1',           method: 'On-chain' },
    { id: 't9', merchant: 'Cursor Pro',        cat: 'tools',  sats: -41200,  when: 'Apr 30',           method: 'Lightning' },
    { id: 't10', merchant: 'Kraken',           cat: 'income', sats: 850000,  when: 'Apr 28',           method: 'On-chain', income: true },
  ],
  // Todos — Todoist style: projects + areas
  projects: [
    { id: 'p1', name: 'Move to Austin', icon: 'box', color: '#F7931A', count: 7 },
    { id: 'p2', name: 'Q2 Tax Filing',  icon: 'doc',  color: '#FFB347', count: 4 },
    { id: 'p3', name: 'Upgrade Node',    icon: 'cpu',  color: '#C97014', count: 3 },
    { id: 'p4', name: 'Cabin Reno',     icon: 'home', color: '#E07B0E', count: 11 },
  ],
  areas: [
    { id: 'a1', name: 'Self-Custody', icon: 'vault' },
    { id: 'a2', name: 'Health',       icon: 'heart' },
    { id: 'a3', name: 'Family',       icon: 'people' },
  ],
  todos: [
    { id: 'd1', text: 'Verify hardware wallet firmware',   project: 'Self-Custody', when: 'Today', flag: true,  done: false },
    { id: 'd2', text: 'Pay quarterly tax estimate',        project: 'Q2 Tax Filing', when: 'Today', flag: false, done: false },
    { id: 'd3', text: 'Confirm DCA bumped to 0.025 BTC/wk',project: 'Self-Custody', when: 'Today', flag: false, done: true  },
    { id: 'd4', text: 'Sign lease addendum',                project: 'Move to Austin', when: 'Today', flag: false, done: false },
    { id: 'd5', text: 'Schedule annual physical',          project: 'Health',         when: 'Today', flag: false, done: false },
    { id: 'd6', text: 'Order new multisig backup plate',   project: 'Self-Custody', when: 'Tomorrow', flag: false, done: false },
    { id: 'd7', text: 'Call moving company',                project: 'Move to Austin', when: 'Tomorrow', flag: false, done: false },
    { id: 'd8', text: 'Review wills with attorney',        project: 'Family',         when: 'May 12',  flag: true,  done: false },
  ],
  // Monthly history — income, spend in USD (truth source).
  // MTD = May (current); savings = income - spend.
  history: [
    { m: 'Jun', y: 2025, income: 11200, spend:  8420 },
    { m: 'Jul', y: 2025, income: 11200, spend:  9180 },
    { m: 'Aug', y: 2025, income: 12400, spend:  8920 },
    { m: 'Sep', y: 2025, income: 11200, spend:  7640 },
    { m: 'Oct', y: 2025, income: 12100, spend:  9210 },
    { m: 'Nov', y: 2025, income: 11200, spend:  8050 },
    { m: 'Dec', y: 2025, income: 18400, spend: 10840 },
    { m: 'Jan', y: 2026, income: 11200, spend:  7820 },
    { m: 'Feb', y: 2026, income: 12100, spend:  8410 },
    { m: 'Mar', y: 2026, income: 12100, spend:  8120 },
    { m: 'Apr', y: 2026, income: 11800, spend:  8640 },
    { m: 'May', y: 2026, income: 12500, spend:  6940, current: true }, // MTD
  ],
  // Retirement — cold storage stacks
  vault: {
    cold: 3.85120,
    hot:  0.36727,
    target: 10.0,
    runwayYears: 18.4,
    dcaWeekly: 250000, // sats / week
    dcaProjection: [
      { year: 2026, btc: 4.22 },
      { year: 2027, btc: 4.74 },
      { year: 2028, btc: 5.31 },
      { year: 2029, btc: 5.94 },
      { year: 2030, btc: 6.62 },
      { year: 2031, btc: 7.36 },
      { year: 2032, btc: 8.16 },
      { year: 2033, btc: 9.02 },
      { year: 2034, btc: 9.94 },
      { year: 2035, btc: 10.92 },
    ],
  },
};

// Formatting
const SATS_PER_BTC = 100_000_000;
// Live BTC price (USD). Read off window so a host page can override it
// (e.g. window.__BTC_USD = 102345) and the whole UI updates on next render.
const getBtcUsd = () => (typeof window !== 'undefined' && window.__BTC_USD) || SEED.price;

const fmtSats = (sats) => {
  const s = Math.abs(sats);
  return (s >= 1000 ? s.toLocaleString('en-US') : String(s));
};
const fmtBTC = (sats) => {
  const btc = sats / SATS_PER_BTC;
  const abs = Math.abs(btc);
  if (abs >= 1) return btc.toFixed(4);
  if (abs >= 0.01) return btc.toFixed(5);
  return btc.toFixed(6);
};
const fmtUSD = (sats) => {
  const usd = (sats / SATS_PER_BTC) * getBtcUsd();
  const abs = Math.abs(usd);
  if (abs >= 1000) return Math.round(usd).toLocaleString('en-US');
  if (abs >= 1)    return usd.toFixed(2);
  return usd.toFixed(2);
};
const fmtAmount = (sats, unit) => {
  if (unit === 'sats') return fmtSats(sats);
  if (unit === 'usd')  return fmtUSD(sats);
  return fmtBTC(sats);
};
const unitLabel = (unit) => unit === 'sats' ? 'SATS' : unit === 'usd' ? 'USD' : 'BTC';
const unitPrefix = (unit) => unit === 'usd' ? '$' : '';

Object.assign(window, { TOKENS, SEED, BTC_ORANGE, BTC_ORANGE_DEEP, BTC_ORANGE_GLOW, SATS_PER_BTC, fmtSats, fmtBTC, fmtUSD, fmtAmount, unitLabel, unitPrefix, getBtcUsd });
