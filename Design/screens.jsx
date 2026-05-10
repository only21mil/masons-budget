// Shared screen primitives + all screens for the Bitcoin Standard app.
// Reads tokens, icons from window globals.

const { useState, useMemo, useRef, useEffect } = React;

// =================================================================
// PRIMITIVES
// =================================================================
const Card = ({ t, children, style, pad = 16, radius = 20, ...rest }) => (
  <div style={{
    background: t.surface, borderRadius: radius,
    border: `1px solid ${t.border}`,
    padding: pad, ...style,
  }} {...rest}>{children}</div>
);

const Section = ({ children, t, style }) => (
  <div style={{ padding: '0 18px', ...style }}>{children}</div>
);

const Hairline = ({ t, indent = 0 }) => (
  <div style={{ height: 1, background: t.border, marginLeft: indent }} />
);

// Amount renderer with BTC/sats/USD toggle
const Amount = ({ sats, unit, t, size = 17, weight = 600, color, sign = false, accent = false }) => {
  const negative = sats < 0;
  const positive = sats > 0;
  const value = fmtAmount(sats, unit);
  const sym = unitPrefix(unit);
  const prefix = sign ? (negative ? '−' : positive ? '+' : '') : (negative ? '−' : '');
  const finalColor = color ?? (accent ? t.accent : t.text);
  return (
    <span style={{
      fontFamily: '"Geist Mono", "SF Mono", ui-monospace, monospace',
      fontSize: size, fontWeight: weight, color: finalColor,
      letterSpacing: '-0.01em', whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }}>
      {prefix}{sym}{value} <span style={{ fontSize: size * 0.62, opacity: 0.55, fontWeight: 500, marginLeft: 2 }}>{unit === 'usd' ? '' : unitLabel(unit)}</span>
    </span>
  );
};

// Tab pill
const Pill = ({ active, t, children, onClick, style, accent = false }) => (
  <button onClick={onClick} style={{
    border: 'none', cursor: 'pointer',
    padding: '6px 12px', borderRadius: 999,
    fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
    background: active ? (accent ? t.accent : t.text) : 'transparent',
    color: active ? (accent ? '#fff' : t.surface) : t.textMuted,
    transition: 'all 120ms ease',
    ...style,
  }}>{children}</button>
);

// Generic header for a screen body
const ScreenHeader = ({ title, t, accessory, eyebrow }) => (
  <div style={{ padding: '8px 18px 12px' }}>
    {eyebrow && <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
      textTransform: 'uppercase', color: t.accent, marginBottom: 4,
    }}>{eyebrow}</div>}
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: t.text }}>{title}</div>
      {accessory}
    </div>
  </div>
);

// =================================================================
// UNIT TOGGLE — BTC <-> sats <-> USD
// =================================================================
const UnitToggle = ({ unit, setUnit, t, size = 'sm' }) => {
  const dim = size === 'lg' ? { h: 32, fs: 12, p: '0 11px' } : { h: 26, fs: 10.5, p: '0 8px' };
  return (
    <div style={{
      display: 'inline-flex', background: t.surface2, borderRadius: 999,
      padding: 2, border: `1px solid ${t.border}`,
    }}>
      {[['BTC','btc'],['SATS','sats'],['USD','usd']].map(([label, val]) => (
        <button key={val} onClick={() => setUnit(val)} style={{
          height: dim.h, padding: dim.p, borderRadius: 999, border: 'none', cursor: 'pointer',
          fontSize: dim.fs, fontWeight: 700, letterSpacing: '0.04em',
          background: unit === val ? t.accent : 'transparent',
          color: unit === val ? '#fff' : t.textMuted,
          transition: 'all 120ms ease',
        }}>{label}</button>
      ))}
    </div>
  );
};

// =================================================================
// INCOME & SAVINGS — MTD/YTD with savings rate
// =================================================================
function IncomeCard({ t }) {
  const h = SEED.history;
  const cur = h[h.length - 1];
  const ytd = h.filter(x => x.y === cur.y);
  const mtdInc = cur.income, mtdSpend = cur.spend;
  const ytdInc = ytd.reduce((a, x) => a + x.income, 0);
  const ytdSpend = ytd.reduce((a, x) => a + x.spend, 0);
  const mtdSav = mtdInc - mtdSpend;
  const ytdSav = ytdInc - ytdSpend;
  const mtdRate = mtdInc > 0 ? Math.round((mtdSav / mtdInc) * 100) : 0;
  const ytdRate = ytdInc > 0 ? Math.round((ytdSav / ytdInc) * 100) : 0;

  const Cell = ({ label, primary, sub, rate }) => (
    <div style={{ flex: 1, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 6, fontFamily: '"Geist Mono", "SF Mono", ui-monospace, monospace', fontSize: 22, fontWeight: 700, color: t.text, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
        ${primary.toLocaleString('en-US')}
      </div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.textFaint }}>
        <span style={{
          background: rate >= 30 ? t.accentSoft2 : t.surface2,
          color: rate >= 30 ? t.accent : t.textMuted,
          padding: '2px 6px', borderRadius: 5, fontWeight: 700,
          fontFamily: '"Geist Mono", ui-monospace, monospace',
        }}>{rate}%</span>
        <span>{sub}</span>
      </div>
    </div>
  );

  return (
    <Card t={t} pad={0} radius={20}>
      <div style={{ display: 'flex' }}>
        <Cell label="Income MTD" primary={mtdInc} sub={`saved $${mtdSav.toLocaleString('en-US')}`} rate={mtdRate}/>
        <div style={{ width: 1, background: t.border, margin: '12px 0' }}/>
        <Cell label="Income YTD" primary={ytdInc} sub={`saved $${ytdSav.toLocaleString('en-US')}`} rate={ytdRate}/>
      </div>
      {/* Income / Spend overlay + savings rate line */}
      <div style={{ borderTop: `1px solid ${t.border}`, padding: '14px 14px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Income · Spend · Savings %</div>
          <div style={{ display: 'flex', gap: 10, fontSize: 10, color: t.textFaint, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, background: t.accent, borderRadius: 2 }}/>Income</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, background: t.borderStrong, borderRadius: 2 }}/>Spend</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 2, background: t.success }}/>Save %</span>
          </div>
        </div>
        {(() => {
          const maxAmt = Math.max(...h.map(x => x.income));
          // SVG with grouped income/spend bars + overlaid savings-rate line.
          return (
            <div style={{ position: 'relative', height: 64 }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ overflow: 'visible' }}>
                {h.map((x, i) => {
                  const slot = 100 / h.length;
                  const cx = i * slot + slot/2;
                  const bw = slot * 0.32;
                  const incH = (x.income / maxAmt) * 86;
                  const spdH = (x.spend / maxAmt) * 86;
                  return (
                    <g key={i}>
                      <rect x={cx - bw - 0.4} y={100 - incH} width={bw} height={incH}
                        fill={x.current ? t.accent : t.accentSoft2} rx="0.6"/>
                      <rect x={cx + 0.4} y={100 - spdH} width={bw} height={spdH}
                        fill={t.borderStrong} rx="0.6"/>
                    </g>
                  );
                })}
                {/* Savings-rate line (0–60%) */}
                <path d={h.map((x, i) => {
                  const r = (x.income - x.spend) / x.income;
                  const slot = 100 / h.length;
                  const cx = i * slot + slot/2;
                  const cy = 100 - (r / 0.6) * 86;
                  return `${i === 0 ? 'M' : 'L'} ${cx} ${cy}`;
                }).join(' ')} fill="none" stroke={t.success} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/>
                {h.map((x, i) => {
                  const r = (x.income - x.spend) / x.income;
                  const slot = 100 / h.length;
                  const cx = i * slot + slot/2;
                  const cy = 100 - (r / 0.6) * 86;
                  return <circle key={i} cx={cx} cy={cy} r={x.current ? 1.6 : 1} fill={t.success}/>;
                })}
              </svg>
            </div>
          );
        })()}
        <div style={{ display: 'flex', gap: 0, marginTop: 4 }}>
          {h.map((x, i) => (
            <div key={i} style={{ flex: 1, fontSize: 9, color: t.textFaint, textAlign: 'center', fontWeight: x.current ? 700 : 500, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
              {i % 2 === 0 ? x.m : ''}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
// =================================================================
// RECURRING / SUBSCRIPTIONS — auto-detected, with sats-deflation tracking
// =================================================================
function RecurringCard({ t, unit }) {
  const bills = SEED.bills;
  const totalNow = bills.reduce((a, b) => a + b.sats, 0);
  const totalLast = bills.reduce((a, b) => a + b.satsLastYear, 0);
  const deflPct = ((totalLast - totalNow) / totalLast) * 100;
  return (
    <Card t={t} pad={0} radius={20}>
      <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Recurring · {bills.length} detected</div>
            <div style={{ fontSize: 13, color: t.textFaint, marginTop: 2 }}>Auto-pulled from txn patterns</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 18, fontWeight: 700, color: t.text, letterSpacing: '-0.02em' }}>
              {fmtSats(totalNow)} <span style={{ fontSize: 11, color: t.textFaint, fontWeight: 600 }}>SATS/mo</span>
            </div>
            <div style={{ fontSize: 11, color: t.success, fontWeight: 700, marginTop: 2, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
              ▼ {deflPct.toFixed(1)}% vs '25
            </div>
          </div>
        </div>
      </div>
      {bills.map((b, i) => {
        const cat = SEED.categories.find(c => c.id === b.cat);
        const change = ((b.satsLastYear - b.sats) / b.satsLastYear) * 100;
        return (
          <div key={b.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
            borderBottom: i < bills.length - 1 ? `1px solid ${t.border}` : 'none',
          }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9,
              background: (cat?.color || t.accent) + '22',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <CatGlyph kind={cat?.glyph || 'wrench'} size={14} color={cat?.color || t.accent}/>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{b.name}</div>
                {b.paidThisCycle
                  ? <span style={{ fontSize: 9, fontWeight: 700, color: t.success, background: t.success+'22', padding: '1px 5px', borderRadius: 4, letterSpacing: '0.04em' }}>PAID</span>
                  : <span style={{ fontSize: 9, fontWeight: 700, color: t.accent, background: t.accentSoft, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.04em' }}>DUE {b.day}</span>}
              </div>
              <div style={{ fontSize: 11, color: t.textFaint, fontFamily: '"Geist Mono", ui-monospace, monospace', marginTop: 1 }}>
                {b.method === 'Lightning' ? '⚡' : '⛓'} monthly · day {b.day}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 13, fontWeight: 700, color: t.text }}>
                {fmtSats(b.sats)}
              </div>
              <div style={{ fontSize: 10, color: t.success, fontWeight: 600, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
                ▼{change.toFixed(0)}% YoY
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// =================================================================
// COST BASIS / LOT TRACKING
// =================================================================
function LotsCard({ t }) {
  const lots = SEED.lots;
  const totalSats = lots.reduce((a, l) => a + l.sats, 0);
  const totalBasis = lots.reduce((a, l) => a + l.basisUsd, 0);
  const currentValue = (totalSats / SATS_PER_BTC) * getBtcUsd();
  const unrealized = currentValue - totalBasis;
  return (
    <Card t={t} pad={0} radius={20}>
      <div style={{ padding: '14px 16px 12px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Cost Basis · FIFO</div>
            <div style={{ fontSize: 13, color: t.textFaint, marginTop: 2 }}>{lots.length} lots tracked</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 16, fontWeight: 700, color: t.text }}>
              ${totalBasis.toLocaleString('en-US')}
            </div>
            <div style={{ fontSize: 11, color: t.success, fontWeight: 700, fontFamily: '"Geist Mono", ui-monospace, monospace', marginTop: 2 }}>
              +${Math.round(unrealized).toLocaleString('en-US')} unrealized
            </div>
          </div>
        </div>
      </div>
      {lots.map((l, i) => {
        const value = (l.sats / SATS_PER_BTC) * getBtcUsd();
        const ret = ((value - l.basisUsd) / l.basisUsd) * 100;
        return (
          <div key={l.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
            borderBottom: i < lots.length - 1 ? `1px solid ${t.border}` : 'none',
          }}>
            <div style={{
              width: 6, alignSelf: 'stretch', minHeight: 28,
              background: t.accent, opacity: 0.2 + (i / lots.length) * 0.7,
              borderRadius: 3,
            }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 12, fontWeight: 700, color: t.text }}>{l.id}</div>
                <div style={{ fontSize: 12, color: t.text }}>{l.label}</div>
              </div>
              <div style={{ fontSize: 11, color: t.textFaint, fontFamily: '"Geist Mono", ui-monospace, monospace', marginTop: 1 }}>
                {l.date} · {(l.sats/SATS_PER_BTC).toFixed(4)} BTC · cost ${l.basisUsd.toLocaleString('en-US')}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 13, fontWeight: 700, color: t.text }}>
                ${Math.round(value).toLocaleString('en-US')}
              </div>
              <div style={{ fontSize: 10, color: ret >= 0 ? t.success : t.danger, fontWeight: 700, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
                {ret >= 0 ? '+' : ''}{ret.toFixed(0)}%
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function DashboardScreen({ t, unit, setUnit }) {
  const total = SEED.net.btc * SATS_PER_BTC;
  const change = SEED.net.change30d;
  const monthSpent = SEED.categories.reduce((a, c) => a + c.spent, 0);
  const monthLimit = SEED.categories.reduce((a, c) => a + c.limit, 0);
  const monthPct = Math.round((monthSpent / monthLimit) * 100);

  // mini sparkline
  const spark = [82, 78, 91, 88, 95, 102, 98, 110, 108, 115, 112, 118];
  const max = Math.max(...spark), min = Math.min(...spark);
  const path = spark.map((v, i) => {
    const x = (i / (spark.length - 1)) * 100;
    const y = 100 - ((v - min) / (max - min)) * 80 - 10;
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Hero balance */}
      <div style={{ padding: '8px 18px 20px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: t.accent, marginBottom: 6,
        }}>Net Worth · 100% Bitcoin</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <Amount sats={total} unit={unit} t={t} size={42} weight={700} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, color: t.textMuted, fontSize: 14, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: t.success, fontWeight: 600 }}>
            <ArrowUp size={12} color={t.success}/> +{(change*100).toFixed(1)}%
          </span>
          <span>past 30 days</span>
          <span style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 999,
            background: t.accentSoft, color: t.accent,
            fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
          }}>
            <span style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 10 }}>ATH</span>
            <span style={{ fontFamily: '"Geist Mono", ui-monospace, monospace' }}>{SEED.net.athBtc.toFixed(4)}</span>
            <span style={{ opacity: 0.7, fontWeight: 600 }}>· -{((1 - SEED.net.btc/SEED.net.athBtc)*100).toFixed(1)}%</span>
          </span>
        </div>
        {/* sparkline */}
        <div style={{ marginTop: 16, height: 56, position: 'relative' }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="56">
            <defs>
              <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={t.accent} stopOpacity="0.32"/>
                <stop offset="100%" stopColor={t.accent} stopOpacity="0"/>
              </linearGradient>
            </defs>
            <path d={`${path} L 100 100 L 0 100 Z`} fill="url(#sparkFill)" stroke="none"/>
            <path d={path} fill="none" stroke={t.accent} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="100" cy={100 - ((spark[spark.length-1] - min)/(max-min))*80 - 10} r="2.4" fill={t.accent}/>
          </svg>
        </div>
      </div>

      {/* Stat row */}
      <div style={{ padding: '0 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <Card t={t} pad={14} radius={16}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: t.plum, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            <span style={{ width: 18, height: 18, borderRadius: 6, background: t.plumSoft, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Vault size={11} color={t.plum}/>
            </span>
            Cold Storage
          </div>
          <div style={{ marginTop: 8 }}>
            <Amount sats={SEED.vault.cold * SATS_PER_BTC} unit={unit} t={t} size={20} weight={700}/>
          </div>
          <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>{((SEED.vault.cold/SEED.net.btc)*100).toFixed(0)}% of stack · multisig</div>
        </Card>
        <Card t={t} pad={14} radius={16}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: t.info, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            <span style={{ width: 18, height: 18, borderRadius: 6, background: t.infoSoft, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Bolt size={11} color={t.info}/>
            </span>
            Spending Wallet
          </div>
          <div style={{ marginTop: 8 }}>
            <Amount sats={SEED.vault.hot * SATS_PER_BTC} unit={unit} t={t} size={20} weight={700}/>
          </div>
          <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>Lightning · daily</div>
        </Card>
      </div>

      {/* Income & savings */}
      <div style={{ padding: '0 18px', marginBottom: 14 }}>
        <IncomeCard t={t}/>
      </div>

      {/* This month spending */}
      <div style={{ padding: '0 18px', marginBottom: 14 }}>
        <Card t={t} pad={16} radius={20}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>May Spending</div>
              <div style={{ fontSize: 13, color: t.textFaint, marginTop: 2 }}>{monthPct}% of monthly limit</div>
            </div>
            <Amount sats={monthSpent} unit={unit} t={t} size={18} weight={700}/>
          </div>
          {/* Stacked bar */}
          <div style={{ height: 10, borderRadius: 6, overflow: 'hidden', display: 'flex', background: t.surface2 }}>
            {SEED.categories.map(c => (
              <div key={c.id} style={{
                width: `${(c.spent / monthLimit) * 100}%`,
                background: c.color, opacity: 0.85,
                borderRight: `1px solid ${t.surface}`,
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 10 }}>
            {SEED.categories.slice(0, 4).map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textMuted }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color }} />{c.name}
              </div>
            ))}
            <div style={{ fontSize: 12, color: t.textFaint }}>+{SEED.categories.length - 4} more</div>
          </div>
        </Card>
      </div>

      {/* Today todos preview */}
      <div style={{ padding: '0 18px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text, letterSpacing: '-0.01em' }}>Today</div>
          <div style={{ fontSize: 12, color: t.accent, fontWeight: 600 }}>4 tasks</div>
        </div>
        <Card t={t} pad={0} radius={20}>
          {SEED.todos.filter(d => d.when === 'Today').slice(0, 4).map((d, i, arr) => (
            <div key={d.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
              borderBottom: i < arr.length - 1 ? `1px solid ${t.border}` : 'none',
            }}>
              <CheckCircle size={20} color={t.borderStrong} accent={t.accent} filled={d.done}/>
              <div style={{ flex: 1, fontSize: 14, color: d.done ? t.textFaint : t.text, textDecoration: d.done ? 'line-through' : 'none' }}>{d.text}</div>
              {d.flag && <Flag size={13} color={t.accent} filled={true}/>}
              <div style={{ fontSize: 11, color: t.textFaint }}>{d.project}</div>
            </div>
          ))}
        </Card>
      </div>

      {/* Recent transactions */}
      <div style={{ padding: '0 18px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>Recent activity</div>
          <div style={{ fontSize: 12, color: t.accent, fontWeight: 600 }}>See all</div>
        </div>
        <Card t={t} pad={0} radius={20}>
          {SEED.txns.slice(0, 4).map((tx, i, arr) => {
            const cat = SEED.categories.find(c => c.id === tx.cat);
            return (
              <div key={tx.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                borderBottom: i < arr.length - 1 ? `1px solid ${t.border}` : 'none',
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                  background: tx.income ? t.accentSoft2 : (cat?.color ? cat.color + '22' : t.surface2),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {tx.income
                    ? <BtcGlyph size={18} color={t.accent}/>
                    : tx.dca
                      ? <Stack size={16} color={t.accent}/>
                      : <CatGlyph kind={cat?.glyph || 'wrench'} size={16} color={cat?.color || t.text}/>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.merchant}</div>
                  <div style={{ fontSize: 11, color: t.textFaint, display: 'flex', alignItems: 'center', gap: 5 }}>
                    {tx.method === 'Lightning' ? <Bolt size={10} color={t.textFaint}/> : <Chain size={10} color={t.textFaint}/>}
                    {tx.method} · {tx.when}
                  </div>
                </div>
                <Amount sats={tx.sats} unit={unit} t={t} size={14} weight={600} sign accent={tx.income}/>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

// =================================================================
// BUDGET CATEGORIES
// =================================================================
function BudgetScreen({ t, unit }) {
  // Budget is naturally fiat-denominated — always show USD on this screen.
  unit = 'usd';
  const h = SEED.history;
  const [monthIdx, setMonthIdx] = useState(h.length - 1);
  const selected = h[monthIdx];
  const isCurrent = !!selected.current;
  // For non-current months, fake category breakdown by scaling to spend total
  const total = SEED.categories.reduce((a, c) => a + c.spent, 0);
  const limit = SEED.categories.reduce((a, c) => a + c.limit, 0);
  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Budget" t={t} eyebrow={`${selected.m} ${selected.y}${isCurrent ? ' · MTD' : ''}`}/>

      {/* Month strip */}
      <div style={{ padding: '0 18px 14px', overflowX: 'auto' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {h.map((m, i) => {
            const on = i === monthIdx;
            const r = (m.income - m.spend) / m.income;
            return (
              <button key={i} onClick={() => setMonthIdx(i)} style={{
                flexShrink: 0, padding: '8px 12px', borderRadius: 12,
                background: on ? t.accent : t.surface,
                color: on ? '#fff' : t.text,
                border: `1px solid ${on ? t.accent : t.border}`,
                cursor: 'pointer', textAlign: 'left', minWidth: 64,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: on ? 0.85 : 0.55 }}>
                  {m.m} '{String(m.y).slice(2)}{m.current ? ' · now' : ''}
                </div>
                <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 14, fontWeight: 700, marginTop: 2 }}>
                  ${m.spend.toLocaleString('en-US')}
                </div>
                <div style={{ fontSize: 10, opacity: on ? 0.85 : 0.6, fontWeight: 600 }}>
                  {Math.round(r*100)}% saved
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '0 18px 16px' }}>
        <Card t={t} pad={16} radius={20}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 600 }}>{isCurrent ? 'Spent / Limit' : 'Spent / Income'}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
              <span style={{ fontSize: 20, fontWeight: 700, color: t.text, letterSpacing: '-0.02em' }}>
                ${selected.spend.toLocaleString('en-US')}
              </span>
              <span style={{ color: t.textFaint, fontSize: 13 }}>/ ${(isCurrent ? Math.round(limit/SATS_PER_BTC*getBtcUsd()) : selected.income).toLocaleString('en-US')}</span>
            </div>
          </div>
          <div style={{ marginTop: 12, height: 8, borderRadius: 4, background: t.surface2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (selected.spend / (isCurrent ? Math.round(limit/SATS_PER_BTC*getBtcUsd()) : selected.income)) * 100)}%`, height: '100%', background: t.accent }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: t.textMuted, display: 'flex', justifyContent: 'space-between' }}>
            <span>{Math.round((selected.spend / selected.income)*100)}% of income spent</span>
            <span style={{ color: t.success, fontWeight: 600 }}>${(selected.income - selected.spend).toLocaleString('en-US')} saved</span>
          </div>
        </Card>
      </div>

      {/* Recurring / Subscriptions */}
      <div style={{ padding: '0 18px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Recurring</div>
        <RecurringCard t={t} unit={unit}/>
      </div>

      <div style={{ padding: '0 18px 8px', fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Categories</div>
      <div style={{ padding: '0 18px' }}>
        {SEED.categories.map(c => {
          const pct = Math.min(100, (c.spent / c.limit) * 100);
          const over = c.spent > c.limit;
          const close = pct >= 85 && !over;
          const safe = !over && !close;
          const statusColor = over ? t.danger : close ? t.warn : t.success;
          const statusSoft = over ? t.dangerSoft : close ? t.warnSoft : t.successSoft;
          const statusLabel = over ? 'OVER' : close ? 'CLOSE' : 'ON TRACK';
          const remainingPct = Math.max(0, 100 - pct);
          return (
            <Card key={c.id} t={t} pad={14} radius={16} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                  background: statusSoft,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <CatGlyph kind={c.glyph} size={18} color={statusColor}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: t.text }}>{c.name}</div>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                        color: statusColor, background: statusSoft,
                        padding: '2px 6px', borderRadius: 4,
                        fontFamily: '"Geist Mono", ui-monospace, monospace',
                      }}>{statusLabel}</span>
                    </div>
                    <Amount sats={c.spent} unit={unit} t={t} size={14} weight={700}/>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 10 }}>
                    <div style={{ flex: 1, height: 6, background: t.surface2, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: statusColor,
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: t.textMuted, fontFamily: '"Geist Mono", ui-monospace, monospace', minWidth: 76, textAlign: 'right' }}>
                      {safe ? <span style={{ color: t.success, fontWeight: 700 }}>{remainingPct.toFixed(0)}% left</span>
                        : close ? <span style={{ color: t.warn, fontWeight: 700 }}>{remainingPct.toFixed(0)}% left</span>
                        : <span style={{ color: t.danger, fontWeight: 700 }}>+{(pct-100).toFixed(0)}% over</span>}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// =================================================================
// CSV IMPORT — bring in account statements
// =================================================================
const IMPORT_SOURCES = [
  { id: 'strike',   name: 'Strike',        kind: 'on-chain', glyph: '⚡', desc: 'Date, Amount BTC, Type, Memo' },
  { id: 'cashapp',  name: 'Cash App',      kind: 'lightning', glyph: '$', desc: 'Date, Asset Amount, Notes' },
  { id: 'coinbase', name: 'Coinbase',      kind: 'on-chain', glyph: 'C', desc: 'Timestamp, Quantity, Spot Price USD' },
  { id: 'kraken',   name: 'Kraken',        kind: 'on-chain', glyph: 'K', desc: 'time, asset, amount, fee' },
  { id: 'wallet',   name: 'Self-custody node', kind: 'on-chain', glyph: '⛓', desc: 'Generic Bitcoin Core CSV' },
  { id: 'custom',   name: 'Custom CSV',    kind: 'mixed',    glyph: '∎', desc: 'Map columns yourself' },
];

const SAMPLE_ROWS = {
  strike: [
    { d: 'May 7', m: 'Strike DCA',         sats: -2100000, c: 'dca',    method: 'On-chain' },
    { d: 'May 6', m: 'Inbound LN',          sats:  500000,  c: 'income', method: 'Lightning', income: true },
    { d: 'May 4', m: 'BTC purchase',        sats: -1800000, c: 'dca',    method: 'On-chain' },
    { d: 'Apr 30', m: 'DCA',                sats: -2100000, c: 'dca',    method: 'On-chain' },
  ],
  cashapp: [
    { d: 'May 7', m: 'Boost cashback',      sats: 4200,    c: 'income', method: 'Lightning', income: true },
    { d: 'May 5', m: 'Sent to a friend',    sats: -22000,  c: 'gifts',  method: 'Lightning' },
    { d: 'May 2', m: 'Direct deposit',      sats: 8400000, c: 'income', method: 'On-chain', income: true },
  ],
  coinbase: [
    { d: 'May 6', m: 'Recurring buy',       sats: -1900000, c: 'dca',    method: 'On-chain' },
    { d: 'May 1', m: 'Coinbase rewards',    sats: 12400,   c: 'income', method: 'On-chain', income: true },
    { d: 'Apr 28', m: 'Convert USDC → BTC', sats: -3200000, c: 'dca',    method: 'On-chain' },
  ],
  kraken: [
    { d: 'May 5', m: 'Spot purchase',       sats: -2400000, c: 'dca',    method: 'On-chain' },
    { d: 'Apr 28', m: 'Withdrawal to vault', sats: -8500000, c: 'dca',    method: 'On-chain' },
  ],
  wallet: [
    { d: 'May 8', m: 'Inbound — payroll',   sats: 12400000, c: 'income', method: 'On-chain', income: true },
    { d: 'May 1', m: 'Outbound — rent',      sats: -4500000, c: 'rent',   method: 'On-chain' },
  ],
  custom: [
    { d: 'May 7', m: 'Row 1', sats: -125000, c: 'food',   method: 'Lightning' },
    { d: 'May 6', m: 'Row 2', sats: -82000,  c: 'health', method: 'Lightning' },
  ],
};

function ImportSheet({ t, open, onClose, onImport }) {
  const [step, setStep] = useState('pick'); // pick → preview → done
  const [src, setSrc] = useState(null);
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState({});
  const fileRef = useRef(null);

  // Parse a real CSV if user picks one. Header autodetects amount/date/memo.
  const handleFile = (file) => {
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result || '';
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return;
      const head = lines[0].toLowerCase();
      const cols = head.split(',').map(s => s.trim().replace(/"/g,''));
      const idxDate   = cols.findIndex(c => /date|time/.test(c));
      const idxAmount = cols.findIndex(c => /amount|qty|quantity|sats|btc/.test(c));
      const idxMemo   = cols.findIndex(c => /memo|note|description|merchant|narrative/.test(c));
      const parsed = lines.slice(1, 50).map((ln, i) => {
        const v = ln.split(',').map(s => s.trim().replace(/"/g,''));
        const rawAmt = parseFloat(v[idxAmount] || '0');
        const sats = Math.abs(rawAmt) < 10 ? Math.round(rawAmt * SATS_PER_BTC) : Math.round(rawAmt);
        return {
          d: v[idxDate]?.slice(0, 10) || ('Row ' + (i+1)),
          m: v[idxMemo] || `Imported row ${i+1}`,
          sats,
          c: sats > 0 ? 'income' : guessCategory(v[idxMemo] || ''),
          method: 'On-chain',
          income: sats > 0,
        };
      });
      setRows(parsed);
      const sel = {}; parsed.forEach((_, i) => sel[i] = true);
      setSelected(sel);
      setStep('preview');
    };
    reader.readAsText(file);
  };

  const guessCategory = (memo) => {
    const m = (memo || '').toLowerCase();
    if (/rent|lease|landlord/.test(m)) return 'rent';
    if (/grocery|whole foods|food|cafe|restaurant/.test(m)) return 'food';
    if (/airline|delta|united|hotel|uber|lyft/.test(m)) return 'travel';
    if (/pharmacy|gym|clinic|health/.test(m)) return 'health';
    if (/electric|water|gas|starlink|internet/.test(m)) return 'energy';
    if (/cursor|github|adobe|figma|saas/.test(m)) return 'tools';
    if (/gift|donation/.test(m)) return 'gifts';
    return 'food';
  };

  const useSample = (sourceId) => {
    setSrc(sourceId);
    setFilename(`${IMPORT_SOURCES.find(s => s.id === sourceId).name.toLowerCase()}_statement_2026_05.csv`);
    const sample = SAMPLE_ROWS[sourceId] || SAMPLE_ROWS.custom;
    setRows(sample);
    const sel = {}; sample.forEach((_, i) => sel[i] = true);
    setSelected(sel);
    setStep('preview');
  };

  const reset = () => { setStep('pick'); setSrc(null); setFilename(''); setRows([]); setSelected({}); };
  const close = () => { reset(); onClose && onClose(); };

  if (!open) return null;

  const importable = rows.filter((_, i) => selected[i]);
  const totalIn  = importable.filter(r => r.sats > 0).reduce((a,r) => a + r.sats, 0);
  const totalOut = importable.filter(r => r.sats < 0).reduce((a,r) => a + r.sats, 0);

  return (
    <div onClick={close} style={{
      position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'flex-end', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: t.bg, color: t.text,
        width: '100%', maxHeight: '92%', overflow: 'auto',
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Sheet handle + header */}
        <div style={{ padding: '8px 0 0', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: t.borderStrong }}/>
        </div>
        <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.accent, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {step === 'pick' ? 'Import statement' : step === 'preview' ? 'Review · ' + filename : 'Imported'}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: t.text, marginTop: 2, letterSpacing: '-0.01em' }}>
              {step === 'pick' ? 'Where is it from?' : step === 'preview' ? `${rows.length} rows detected` : 'All set.'}
            </div>
          </div>
          <button onClick={close} style={{
            width: 30, height: 30, borderRadius: 999, border: 'none',
            background: t.surface2, color: t.textMuted, fontSize: 18, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>

        {step === 'pick' && (
          <div style={{ padding: '14px 18px 24px' }}>
            {/* Drop / pick CSV */}
            <input ref={fileRef} type="file" accept=".csv,text/csv"
              onChange={e => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }}/>
            <button onClick={() => fileRef.current?.click()} style={{
              width: '100%', padding: '18px 16px', borderRadius: 16,
              background: t.accentSoft, border: `1.5px dashed ${t.accent}`,
              color: t.accent, fontWeight: 700, fontSize: 14, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            }}>
              <span style={{ fontSize: 22 }}>⬆︎</span>
              Drop CSV or browse
              <span style={{ fontSize: 11, color: t.textMuted, fontWeight: 500 }}>
                Header row autodetected · max 50 rows previewed
              </span>
            </button>

            <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '18px 4px 8px' }}>Or pick a source</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {IMPORT_SOURCES.map(s => (
                <button key={s.id} onClick={() => useSample(s.id)} style={{
                  textAlign: 'left', padding: '12px 12px', borderRadius: 12,
                  background: t.surface, border: `1px solid ${t.border}`,
                  color: t.text, cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: 8,
                      background: t.accentSoft, color: t.accent,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: '"Geist Mono", ui-monospace, monospace', fontWeight: 700,
                    }}>{s.glyph}</span>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{s.name}</div>
                  </div>
                  <div style={{ fontSize: 10, color: t.textFaint, marginTop: 6, fontFamily: '"Geist Mono", ui-monospace, monospace', letterSpacing: '0.01em' }}>
                    {s.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div style={{ padding: '14px 18px 110px' }}>
            {/* Summary */}
            <Card t={t} pad={0} radius={14}>
              <div style={{ display: 'flex' }}>
                <div style={{ flex: 1, padding: '12px 14px', borderRight: `1px solid ${t.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Importing</div>
                  <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 18, fontWeight: 700, marginTop: 4 }}>{importable.length} <span style={{ fontSize: 11, color: t.textFaint }}>/ {rows.length}</span></div>
                </div>
                <div style={{ flex: 1, padding: '12px 14px', borderRight: `1px solid ${t.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: t.success, letterSpacing: '0.08em', textTransform: 'uppercase' }}>In</div>
                  <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 14, fontWeight: 700, marginTop: 4, color: t.success }}>+{fmtSats(totalIn)}</div>
                </div>
                <div style={{ flex: 1, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: t.danger, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Out</div>
                  <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 14, fontWeight: 700, marginTop: 4, color: t.danger }}>{fmtSats(totalOut)}</div>
                </div>
              </div>
            </Card>

            {/* Rows */}
            <div style={{ marginTop: 14 }}>
              <Card t={t} pad={0} radius={14}>
                {rows.map((r, i) => {
                  const cat = SEED.categories.find(c => c.id === r.c);
                  const on = !!selected[i];
                  return (
                    <div key={i} onClick={() => setSelected({ ...selected, [i]: !on })} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                      borderBottom: i < rows.length - 1 ? `1px solid ${t.border}` : 'none',
                      cursor: 'pointer', opacity: on ? 1 : 0.45,
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                        background: on ? t.accent : 'transparent',
                        border: on ? `1.5px solid ${t.accent}` : `1.5px solid ${t.borderStrong}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: 12, fontWeight: 700,
                      }}>{on ? '✓' : ''}</div>
                      <div style={{ fontSize: 10, color: t.textFaint, fontFamily: '"Geist Mono", ui-monospace, monospace', width: 50 }}>{r.d}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.m}</div>
                        <div style={{ fontSize: 10, color: t.textFaint, marginTop: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: (cat?.color || t.accent) + '22',
                            color: cat?.color || t.accent,
                            padding: '1px 5px', borderRadius: 4, fontWeight: 700, fontSize: 9,
                            letterSpacing: '0.04em', textTransform: 'uppercase',
                          }}>{r.income ? 'income' : (cat?.name || 'uncategorized')}</span>
                          <span>·</span>
                          <span>{r.method === 'Lightning' ? '⚡' : '⛓'} {r.method}</span>
                        </div>
                      </div>
                      <div style={{
                        fontFamily: '"Geist Mono", ui-monospace, monospace',
                        fontSize: 12, fontWeight: 700,
                        color: r.sats > 0 ? t.success : t.text,
                      }}>{r.sats > 0 ? '+' : ''}{fmtSats(r.sats)}</div>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* Sticky CTA */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              padding: '12px 18px 22px',
              background: `linear-gradient(180deg, transparent, ${t.bg} 32%)`,
              display: 'flex', gap: 8,
            }}>
              <button onClick={reset} style={{
                padding: '14px 18px', borderRadius: 14,
                background: t.surface, border: `1px solid ${t.border}`,
                color: t.text, fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>Back</button>
              <button onClick={() => { onImport && onImport(importable); setStep('done'); }} style={{
                flex: 1, padding: '14px 18px', borderRadius: 14,
                background: t.accent, border: 'none',
                color: '#1a0d00', fontWeight: 800, fontSize: 14, cursor: 'pointer',
                letterSpacing: '0.01em',
              }}>Import {importable.length} transaction{importable.length === 1 ? '' : 's'}</button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ padding: '24px 22px 32px', textAlign: 'center' }}>
            <div style={{ fontSize: 46 }}>✓</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 6 }}>{importable.length} transactions added</div>
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4 }}>Recurring patterns will be detected on next sync.</div>
            <button onClick={close} style={{
              marginTop: 20, padding: '12px 28px', borderRadius: 12,
              background: t.accent, border: 'none', color: '#1a0d00',
              fontWeight: 800, fontSize: 14, cursor: 'pointer',
            }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// =================================================================
// TRANSACTIONS
// =================================================================
function TransactionsScreen({ t, unit }) {
  const [filter, setFilter] = useState('all');
  const [imported, setImported] = useState([]);
  const [showImport, setShowImport] = useState(false);
  const allTxns = useMemo(() => [...imported, ...SEED.txns], [imported]);
  const filtered = useMemo(() => {
    if (filter === 'all') return allTxns;
    if (filter === 'in') return allTxns.filter(x => x.income);
    if (filter === 'out') return allTxns.filter(x => !x.income);
    if (filter === 'ln') return allTxns.filter(x => x.method === 'Lightning');
    if (filter === 'oc') return allTxns.filter(x => x.method === 'On-chain');
    return allTxns;
  }, [filter, allTxns]);

  // group by day
  const groups = useMemo(() => {
    const map = {};
    filtered.forEach(tx => {
      const k = tx.when.includes(',') ? tx.when.split(',')[0] : tx.when;
      (map[k] = map[k] || []).push(tx);
    });
    return Object.entries(map);
  }, [filtered]);

  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Activity" t={t} eyebrow="Lightning + On-chain"
        accessory={
          <button onClick={() => setShowImport(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 999,
            background: t.accentSoft, border: `1px solid ${t.accent}55`,
            color: t.accent, fontWeight: 700, fontSize: 12, cursor: 'pointer',
            letterSpacing: '0.01em',
          }}>
            <span style={{ fontSize: 13 }}>⬆︎</span> Import CSV
          </button>
        }
      />
      <div style={{ padding: '0 18px 14px', display: 'flex', gap: 6, overflowX: 'auto' }}>
        {[
          { id: 'all', label: 'All' },
          { id: 'in',  label: 'Income' },
          { id: 'out', label: 'Spends' },
          { id: 'ln',  label: 'Lightning' },
          { id: 'oc',  label: 'On-chain' },
        ].map(p => <Pill key={p.id} t={t} active={filter === p.id} accent onClick={() => setFilter(p.id)}>{p.label}</Pill>)}
      </div>

      <div style={{ padding: '0 18px' }}>
        {groups.map(([day, txs]) => (
          <div key={day} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 4px 8px' }}>{day}</div>
            <Card t={t} pad={0} radius={16}>
              {txs.map((tx, i) => {
                const cat = SEED.categories.find(c => c.id === tx.cat);
                return (
                  <div key={tx.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                    borderBottom: i < txs.length - 1 ? `1px solid ${t.border}` : 'none',
                  }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                      background: tx.income ? t.accentSoft2 : (cat?.color ? cat.color + '22' : t.surface2),
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {tx.income ? <BtcGlyph size={18} color={t.accent}/>
                        : tx.dca ? <Stack size={16} color={t.accent}/>
                        : <CatGlyph kind={cat?.glyph || 'wrench'} size={16} color={cat?.color || t.text}/>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{tx.merchant}</div>
                      <div style={{ fontSize: 11, color: t.textFaint, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                        {tx.method === 'Lightning' ? <Bolt size={10} color={t.textFaint}/> : <Chain size={10} color={t.textFaint}/>}
                        {tx.method}{tx.when.includes(',') ? ' · ' + tx.when.split(',')[1].trim() : ''}
                      </div>
                    </div>
                    <Amount sats={tx.sats} unit={unit} t={t} size={14} weight={700} sign accent={tx.income}/>
                  </div>
                );
              })}
            </Card>
          </div>
        ))}
      </div>
      <ImportSheet t={t} open={showImport} onClose={() => setShowImport(false)}
        onImport={rows => {
          const stamped = rows.map((r, i) => ({
            id: 'imp' + Date.now() + '-' + i,
            merchant: r.m, cat: r.c, sats: r.sats,
            when: r.d, method: r.method, income: !!r.income,
            imported: true,
          }));
          setImported([...stamped, ...imported]);
        }}
      />
    </div>
  );
}

// =================================================================
// ADD TRANSACTION
// =================================================================
function AddTxnScreen({ t, unit, onClose, onAdd }) {
  const [type, setType] = useState('spend');
  const [inputUnit, setInputUnit] = useState(unit || 'usd');
  const [amount, setAmount] = useState(inputUnit === 'usd' ? '38' : '38400');
  const [cat, setCat] = useState('food');
  const [method, setMethod] = useState('Lightning');
  const [merchant, setMerchant] = useState('');

  const numeric = parseFloat(amount.replace(/[^0-9.]/g, '')) || 0;
  const sats = inputUnit === 'sats' ? Math.round(numeric)
             : inputUnit === 'btc'  ? Math.round(numeric * SATS_PER_BTC)
             : Math.round((numeric / getBtcUsd()) * SATS_PER_BTC);

  const switchUnit = (u) => {
    // re-express current sats in the new unit so the number stays meaningful
    if (u === inputUnit) return;
    const next = u === 'sats' ? String(Math.round(sats))
               : u === 'btc'  ? (sats / SATS_PER_BTC).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
               : (sats / SATS_PER_BTC * getBtcUsd()).toFixed(2);
    setAmount(next);
    setInputUnit(u);
  };

  const Key = ({ label, onPress }) => (
    <button onClick={onPress} style={{
      flex: 1, height: 56, border: 'none', cursor: 'pointer',
      background: 'transparent', borderRadius: 10,
      fontSize: 26, fontWeight: 500, color: t.text,
      fontFamily: '-apple-system, system-ui',
    }}>{label}</button>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: t.bg }}>
      {/* Modal header */}
      <div style={{ padding: '20px 18px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: t.accent, fontSize: 16, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
        <div style={{ fontSize: 16, fontWeight: 700, color: t.text }}>New transaction</div>
        <button onClick={() => onAdd?.()} style={{ background: 'transparent', border: 'none', color: t.accent, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>Save</button>
      </div>

      {/* Type segmented */}
      <div style={{ padding: '12px 18px 0' }}>
        <div style={{ display: 'flex', background: t.surface2, borderRadius: 12, padding: 3 }}>
          {[
            { id: 'spend', l: 'Spend' },
            { id: 'income', l: 'Income' },
            { id: 'transfer', l: 'Transfer' },
          ].map(s => (
            <button key={s.id} onClick={() => setType(s.id)} style={{
              flex: 1, height: 34, border: 'none', cursor: 'pointer',
              background: type === s.id ? t.surface : 'transparent',
              color: type === s.id ? t.text : t.textMuted,
              borderRadius: 9, fontSize: 13, fontWeight: 600,
              boxShadow: type === s.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 120ms',
            }}>{s.l}</button>
          ))}
        </div>
      </div>

      {/* Big amount */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: t.accent, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
          Amount
        </div>
        {/* Input unit selector */}
        <div style={{ display: 'inline-flex', background: t.surface2, borderRadius: 999, padding: 2, border: `1px solid ${t.border}`, marginBottom: 10 }}>
          {[['USD','usd'],['BTC','btc'],['SATS','sats']].map(([l, v]) => (
            <button key={v} onClick={() => switchUnit(v)} style={{
              height: 26, padding: '0 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              background: inputUnit === v ? t.accent : 'transparent',
              color: inputUnit === v ? '#fff' : t.textMuted,
              transition: 'all 120ms ease',
            }}>{l}</button>
          ))}
        </div>
        <div style={{
          fontFamily: '"Geist Mono", "SF Mono", ui-monospace, monospace',
          fontSize: 56, fontWeight: 700, color: t.text,
          letterSpacing: '-0.03em', display: 'flex', alignItems: 'baseline', gap: 8,
        }}>
          {type === 'spend' && <span style={{ color: t.textFaint }}>−</span>}
          {unitPrefix(inputUnit)}{amount || '0'}
          <span style={{ fontSize: 18, fontWeight: 600, color: t.textMuted, letterSpacing: 0.04 }}>{inputUnit === 'usd' ? '' : unitLabel(inputUnit)}</span>
        </div>
        <div style={{ fontSize: 13, color: t.textFaint, marginTop: 4 }}>
          {inputUnit === 'usd'  && '≈ ' + fmtSats(sats) + ' SATS · ' + fmtBTC(sats) + ' BTC'}
          {inputUnit === 'btc'  && '≈ ' + fmtSats(sats) + ' SATS · $' + fmtUSD(sats)}
          {inputUnit === 'sats' && '≈ ' + fmtBTC(sats) + ' BTC · $' + fmtUSD(sats)}
        </div>

        {/* Quick fields */}
        <div style={{ width: '100%', marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Card t={t} pad={0} radius={14}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 13, color: t.textMuted, width: 88 }}>Category</div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: SEED.categories.find(c=>c.id===cat)?.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CatGlyph kind={SEED.categories.find(c=>c.id===cat)?.glyph} size={11} color="#fff"/>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{SEED.categories.find(c=>c.id===cat)?.name}</div>
              </div>
              <ArrowRight size={12} color={t.textFaint}/>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', borderBottom: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 13, color: t.textMuted, width: 88 }}>Method</div>
              <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                {['Lightning', 'On-chain'].map(m => (
                  <button key={m} onClick={() => setMethod(m)} style={{
                    border: `1px solid ${method === m ? t.accent : t.border}`, cursor: 'pointer',
                    background: method === m ? t.accentSoft : 'transparent',
                    color: method === m ? t.accent : t.text,
                    padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    {m === 'Lightning' ? <Bolt size={11} color={method === m ? t.accent : t.textMuted}/> : <Chain size={11} color={method === m ? t.accent : t.textMuted}/>}
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px' }}>
              <div style={{ fontSize: 13, color: t.textMuted, width: 88 }}>Merchant</div>
              <input
                value={merchant}
                onChange={e => setMerchant(e.target.value)}
                placeholder="Where?"
                style={{
                  flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  fontSize: 14, fontWeight: 600, color: t.text,
                }}
              />
            </div>
          </Card>
        </div>
      </div>

      {/* Pad */}
      <div style={{ padding: '8px 8px 4px' }}>
        {[['1','2','3'],['4','5','6'],['7','8','9'],['.','0','⌫']].map((row, i) => (
          <div key={i} style={{ display: 'flex' }}>
            {row.map(k => (
              <Key key={k} label={k} onPress={() => {
                if (k === '⌫') setAmount(amount.slice(0, -1));
                else if (k === '.' && amount.includes('.')) return;
                else if (k === '.' && inputUnit === 'sats') return;
                else setAmount(amount + k);
              }}/>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// =================================================================
// TODOS — TODAY
// =================================================================
function TodayScreen({ t }) {
  const [todos, setTodos] = useState(SEED.todos);
  const [bills, setBills] = useState(SEED.bills);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const today = todos.filter(d => d.when === 'Today');
  const upcoming = todos.filter(d => d.when !== 'Today');
  const dueBills = bills.filter(b => !b.paidThisCycle);

  const toggle = (id) => setTodos(todos.map(d => d.id === id ? { ...d, done: !d.done } : d));
  const payBill = (id) => setBills(bills.map(b => b.id === id ? { ...b, paidThisCycle: true } : b));

  const Row = ({ d }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
      <button onClick={() => toggle(d.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
        <CheckCircle size={22} color={t.borderStrong} accent={t.accent} filled={d.done}/>
      </button>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, color: d.done ? t.textFaint : t.text, textDecoration: d.done ? 'line-through' : 'none', fontWeight: 500 }}>{d.text}</div>
        <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: 1.5, background: t.accent, opacity: 0.5 }}/>
          {d.project}
        </div>
      </div>
      {d.flag && <Flag size={13} color={t.accent} filled={true}/>}
    </div>
  );

  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Today" t={t} eyebrow="Thursday · May 8"/>

      {/* Bills due this cycle — checking pays the bill AND logs the txn */}
      {dueBills.length > 0 && (
        <div style={{ padding: '0 18px 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Bills due</span>
            <span style={{ color: t.accent }}>{dueBills.length} pending</span>
          </div>
          <Card t={t} pad={0} radius={20}>
            {dueBills.map((b, i) => {
              const cat = SEED.categories.find(c => c.id === b.cat);
              return (
                <div key={b.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                  borderBottom: i < dueBills.length - 1 ? `1px solid ${t.border}` : 'none',
                }}>
                  <button onClick={() => payBill(b.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    <CheckCircle size={22} color={t.accent} accent={t.accent} filled={false}/>
                  </button>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                    background: (cat?.color || t.accent) + '22',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <CatGlyph kind={cat?.glyph || 'wrench'} size={13} color={cat?.color || t.accent}/>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: t.text, fontWeight: 600 }}>Pay {b.name}</div>
                    <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
                      <span>{b.method === 'Lightning' ? '⚡' : '⛓'}</span>
                      <span>auto-logs {fmtSats(b.sats)} SATS · day {b.day}</span>
                    </div>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: t.accent, background: t.accentSoft, padding: '2px 6px', borderRadius: 4, letterSpacing: '0.04em' }}>BILL</span>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      <div style={{ padding: '0 18px 6px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px', display: 'flex', justifyContent: 'space-between' }}>
          <span>Tasks</span>
          <span>{today.filter(d => !d.done).length} remaining</span>
        </div>
        <Card t={t} pad={0} radius={20}>
          {today.map((d, i) => (
            <React.Fragment key={d.id}>
              <Row d={d}/>
              {i < today.length - 1 && <Hairline t={t} indent={48}/>}
            </React.Fragment>
          ))}
          {/* add task button */}
          {draftOpen ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: `1px solid ${t.border}` }}>
              <CheckCircle size={22} color={t.borderStrong} accent={t.accent}/>
              <input
                autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                onBlur={() => { setDraftOpen(false); setDraft(''); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && draft.trim()) {
                    setTodos([...todos, { id: 'n'+Date.now(), text: draft, project: 'Inbox', when: 'Today', flag: false, done: false }]);
                    setDraft(''); setDraftOpen(false);
                  }
                }}
                placeholder="New task"
                style={{
                  flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  fontSize: 15, color: t.text, fontWeight: 500,
                }}
              />
            </div>
          ) : (
            <button onClick={() => setDraftOpen(true)} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', width: '100%',
              borderTop: `1px solid ${t.border}`, background: 'transparent', border: 'none', cursor: 'pointer',
              borderTopColor: t.border, borderTopStyle: 'solid', borderTopWidth: 1,
            }}>
              <Plus size={20} color={t.accent}/>
              <span style={{ fontSize: 15, color: t.accent, fontWeight: 600 }}>Add task</span>
            </button>
          )}
        </Card>
      </div>

      <div style={{ padding: '14px 18px 0' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Upcoming</div>
        <Card t={t} pad={0} radius={20}>
          {upcoming.map((d, i) => (
            <React.Fragment key={d.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                <CheckCircle size={22} color={t.borderStrong} accent={t.accent} filled={d.done}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: t.text, fontWeight: 500 }}>{d.text}</div>
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>{d.project}</div>
                </div>
                {d.flag && <Flag size={13} color={t.accent} filled={true}/>}
                <div style={{ fontSize: 12, color: t.accent, fontWeight: 600 }}>{d.when}</div>
              </div>
              {i < upcoming.length - 1 && <Hairline t={t} indent={48}/>}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
}

// =================================================================
// TODOS — PROJECTS / AREAS
// =================================================================
function ProjectsScreen({ t }) {
  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Projects" t={t} eyebrow="Areas of focus"/>
      <div style={{ padding: '0 18px 14px' }}>
        {/* Pinned shortcuts */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          {[
            { l: 'Inbox', n: 2, icon: <Inbox size={18} color={t.accent}/> },
            { l: 'Today', n: 5, icon: <Target size={18} color={t.accent}/> },
            { l: 'Upcoming', n: 14, icon: <Calendar size={18} color={t.accent}/> },
            { l: 'Flagged', n: 2, icon: <Flag size={16} color={t.accent} filled/> },
          ].map(s => (
            <Card key={s.l} t={t} pad={14} radius={16}>
              <div style={{
                width: 32, height: 32, borderRadius: 9, background: t.accentSoft,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10,
              }}>{s.icon}</div>
              <div style={{ fontSize: 13, color: t.textMuted, fontWeight: 500 }}>{s.l}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: t.text, letterSpacing: '-0.02em', marginTop: 2 }}>{s.n}</div>
            </Card>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Projects</div>
        <Card t={t} pad={0} radius={20} style={{ marginBottom: 14 }}>
          {SEED.projects.map((p, i) => (
            <React.Fragment key={p.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: p.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CatGlyph kind={p.icon} size={16} color={p.color}/>
                </div>
                <div style={{ flex: 1, fontSize: 15, color: t.text, fontWeight: 500 }}>{p.name}</div>
                <div style={{ fontSize: 13, color: t.textFaint, fontVariantNumeric: 'tabular-nums' }}>{p.count}</div>
                <ArrowRight size={12} color={t.textFaint}/>
              </div>
              {i < SEED.projects.length - 1 && <Hairline t={t} indent={58}/>}
            </React.Fragment>
          ))}
        </Card>

        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Areas</div>
        <Card t={t} pad={0} radius={20}>
          {SEED.areas.map((a, i) => (
            <React.Fragment key={a.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CatGlyph kind={a.icon} size={16} color={t.textMuted}/>
                </div>
                <div style={{ flex: 1, fontSize: 15, color: t.text, fontWeight: 500 }}>{a.name}</div>
                <ArrowRight size={12} color={t.textFaint}/>
              </div>
              {i < SEED.areas.length - 1 && <Hairline t={t} indent={58}/>}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
}

// =================================================================
// RETIREMENT — vault, runway, stacking goal, DCA projection
// =================================================================
function RetirementScreen({ t, unit }) {
  // Retirement planning anchors in USD purchasing power.
  unit = 'usd';
  const v = SEED.vault;
  const [extraBtcPerMonth, setExtraBtcPerMonth] = useState(0);
  const goalPct = (SEED.net.btc / v.target) * 100;

  // DCA projection chart
  const proj = v.dcaProjection;
  // Apply slider's extra contributions: each year the projection grows by 12 * extraBtcPerMonth more
  const adjustedProj = proj.map((p, i) => ({ ...p, btc: p.btc + (i * 12 * extraBtcPerMonth) }));
  const max = Math.max(...adjustedProj.map(p => p.btc), v.target);
  const min = Math.min(...adjustedProj.map(p => p.btc));
  const path = adjustedProj.map((p, i) => {
    const x = (i / (adjustedProj.length - 1)) * 100;
    const y = 100 - ((p.btc - min) / (max - min)) * 80 - 10;
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
  const targetY = 100 - ((v.target - min) / (max - min)) * 80 - 10;
  // Find the year goal is reached
  const reached = adjustedProj.find(p => p.btc >= v.target);
  const goalYear = reached ? reached.year : '—';
  const yearsToGoal = reached ? reached.year - 2026 : null;

  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Retirement" t={t} eyebrow="The Long Stack"/>

      {/* Hero — runway */}
      <div style={{ padding: '0 18px 14px' }}>
        <Card t={t} pad={20} radius={22} style={{
          background: `linear-gradient(135deg, ${t.accent} 0%, ${t.accentDeep} 100%)`,
          border: 'none', color: '#fff',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.85 }}>Projected runway</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <div style={{ fontSize: 50, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, fontFamily: '"SF Mono", ui-monospace, monospace' }}>{v.runwayYears}</div>
            <div style={{ fontSize: 16, fontWeight: 600, opacity: 0.85 }}>years</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>At your current burn, your stack covers life past <b>2044</b>.</div>
          <div style={{ marginTop: 14, height: 6, background: 'rgba(255,255,255,0.25)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, goalPct)}%`, height: '100%', background: '#fff' }}/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, opacity: 0.85, fontWeight: 600 }}>
            <span>{goalPct.toFixed(0)}% of {v.target} BTC goal</span>
            <span>{(v.target - SEED.net.btc).toFixed(2)} BTC to go</span>
          </div>
        </Card>
      </div>

      {/* Vault breakdown */}
      <div style={{ padding: '0 18px 14px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Storage</div>
        <Card t={t} pad={0} radius={18}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px' }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: t.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Vault size={20} color={t.accent}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>Cold Storage · Coldcard Q</div>
              <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>Multi-sig · 2-of-3 · last verified Apr 22</div>
            </div>
            <Amount sats={v.cold * SATS_PER_BTC} unit={unit} t={t} size={14} weight={700}/>
          </div>
          <Hairline t={t} indent={68}/>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px' }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: t.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Bolt size={20} color={t.accent}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>Spending · Phoenix LN</div>
              <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>Self-custodial Lightning</div>
            </div>
            <Amount sats={v.hot * SATS_PER_BTC} unit={unit} t={t} size={14} weight={700}/>
          </div>
        </Card>
      </div>

      {/* DCA projection */}
      <div style={{ padding: '0 18px 14px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px', display: 'flex', justifyContent: 'space-between' }}>
          <span>Goal projector</span>
          <span style={{ color: t.accent, fontWeight: 700 }}>
            {extraBtcPerMonth > 0 ? `+${extraBtcPerMonth.toFixed(3)} BTC/mo` : `${fmtSats(v.dcaWeekly)} SATS/wk`}
          </span>
        </div>
        <Card t={t} pad={16} radius={20}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <div style={{ fontFamily: '"Geist Mono", "SF Mono", ui-monospace, monospace', fontSize: 28, fontWeight: 700, color: t.text, letterSpacing: '-0.02em' }}>
              {goalYear}
            </div>
            <div style={{ fontSize: 13, color: t.textFaint }}>
              {yearsToGoal != null ? `${yearsToGoal} yrs to ${v.target} BTC goal` : 'goal not reached in window'}
            </div>
          </div>
          <div style={{ position: 'relative', height: 140, marginTop: 8 }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ overflow: 'visible' }}>
              <defs>
                <linearGradient id="projFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={t.accent} stopOpacity="0.3"/>
                  <stop offset="100%" stopColor={t.accent} stopOpacity="0"/>
                </linearGradient>
              </defs>
              <line x1="0" x2="100" y1={targetY} y2={targetY} stroke={t.borderStrong} strokeWidth="0.4" strokeDasharray="1.4 1.4" vectorEffect="non-scaling-stroke"/>
              {/* Stack milestones — 1 BTC, 5, 10 BTC */}
              {[1, 5, v.target].filter(m => m >= min && m <= max).map((m, mi) => {
                const my = 100 - ((m - min) / (max - min)) * 80 - 10;
                return (
                  <g key={mi} opacity="0.55">
                    <line x1="0" x2="100" y1={my} y2={my} stroke={t.accent} strokeWidth="0.25" strokeDasharray="0.6 1.2" vectorEffect="non-scaling-stroke"/>
                  </g>
                );
              })}
              <path d={`${path} L 100 100 L 0 100 Z`} fill="url(#projFill)" stroke="none"/>
              <path d={path} fill="none" stroke={t.accent} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/>
              {adjustedProj.map((p, i) => i % 2 === 0 && (
                <circle key={i} cx={(i / (adjustedProj.length-1)) * 100} cy={100 - ((p.btc - min) / (max - min)) * 80 - 10} r="1.6" fill={t.accent}/>
              ))}
              {/* Milestone markers — first year stack crosses 1, 5, 10 BTC */}
              {[1, 5, v.target].map((m, mi) => {
                const idx = adjustedProj.findIndex(p => p.btc >= m);
                if (idx < 0) return null;
                const cx = (idx / (adjustedProj.length-1)) * 100;
                const cy = 100 - ((adjustedProj[idx].btc - min) / (max - min)) * 80 - 10;
                return (
                  <g key={'m'+mi}>
                    <circle cx={cx} cy={cy} r="2.6" fill={t.accent} stroke={t.surface} strokeWidth="0.8"/>
                  </g>
                );
              })}
            </svg>
            {/* Milestone labels */}
            {[
              { v: 1, label: '1 BTC' },
              { v: 5, label: '5 BTC' },
              { v: v.target, label: `${v.target} BTC · goal` },
            ].map((m, mi) => {
              const idx = adjustedProj.findIndex(p => p.btc >= m.v);
              if (idx < 0) return null;
              const left = (idx / (adjustedProj.length-1)) * 100;
              return (
                <div key={mi} style={{
                  position: 'absolute', left: `${left}%`,
                  top: `${100 - ((adjustedProj[idx].btc - min)/(max-min)) * 80 - 10}%`,
                  transform: 'translate(-50%, -160%)',
                  fontSize: 9, fontWeight: 700, color: t.accent,
                  fontFamily: '"Geist Mono", ui-monospace, monospace',
                  background: t.surface, padding: '1px 5px', borderRadius: 4,
                  border: `1px solid ${t.accent}55`, whiteSpace: 'nowrap',
                }}>{m.label}</div>
              );
            })}
            <div style={{ position: 'absolute', top: `${targetY}%`, right: 0, transform: 'translateY(-100%)', fontSize: 10, fontWeight: 600, color: t.textMuted }}>
              Goal · {v.target} BTC
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: t.textFaint, fontVariantNumeric: 'tabular-nums' }}>
            <span>2026</span><span>2030</span><span>2035</span>
          </div>
          {/* Slider — what if I added more */}
          <div style={{ marginTop: 18, padding: '14px 14px 12px', background: t.surface2, borderRadius: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: t.text }}>What if I added…</div>
              <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 13, fontWeight: 700, color: t.accent }}>
                +{extraBtcPerMonth.toFixed(3)} BTC<span style={{ opacity: 0.6, marginLeft: 4 }}>/mo</span>
              </div>
            </div>
            <input type="range" min="0" max="0.05" step="0.001" value={extraBtcPerMonth}
              onChange={e => setExtraBtcPerMonth(parseFloat(e.target.value))}
              style={{
                width: '100%', accentColor: t.accent,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: t.textFaint, fontFamily: '"Geist Mono", ui-monospace, monospace', marginTop: 2 }}>
              <span>0</span><span>0.025</span><span>0.05 BTC</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Cost basis / lot tracking */}
      <div style={{ padding: '0 18px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Lots</div>
        <LotsCard t={t}/>
      </div>
    </div>
  );
}

// =================================================================
// NET WORTH (small, simple — chart + breakdown)
// =================================================================
function NetWorthScreen({ t, unit }) {
  const total = SEED.net.btc * SATS_PER_BTC;
  const series = [3.4, 3.5, 3.5, 3.6, 3.7, 3.8, 3.85, 3.9, 4.0, 4.1, 4.15, 4.22];
  const labels = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May'];
  const max = Math.max(...series), min = Math.min(...series) * 0.92;

  return (
    <div style={{ paddingBottom: 100 }}>
      <ScreenHeader title="Net Worth" t={t} eyebrow="12-month view"/>

      <div style={{ padding: '0 18px 14px' }}>
        <Card t={t} pad={18} radius={22}>
          <div style={{ fontSize: 13, color: t.textMuted, fontWeight: 500 }}>Total</div>
          <div style={{ marginTop: 4 }}>
            <Amount sats={total} unit={unit} t={t} size={32} weight={700}/>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, color: t.success, fontSize: 13, fontWeight: 600 }}>
            <ArrowUp size={11} color={t.success}/>+0.81 BTC <span style={{ color: t.textFaint, fontWeight: 500 }}>past year</span>
          </div>

          {/* Bars chart */}
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
            {series.map((v, i) => {
              const h = ((v - min) / (max - min)) * 100;
              const last = i === series.length - 1;
              return (
                <div key={i} style={{
                  flex: 1, height: `${h}%`, minHeight: 6,
                  background: last ? t.accent : t.accentSoft2,
                  borderRadius: 3, position: 'relative',
                }}>
                  {last && (
                    <div style={{
                      position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)',
                      fontSize: 10, fontWeight: 700, color: t.accent, whiteSpace: 'nowrap',
                    }}>{v.toFixed(2)}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            {labels.map((l, i) => (
              <div key={i} style={{ flex: 1, fontSize: 9, color: t.textFaint, textAlign: 'center', fontWeight: 600 }}>
                {i % 2 === 1 ? l : ''}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ padding: '0 18px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px 8px' }}>Holdings</div>
        <Card t={t} pad={0} radius={18}>
          {[
            { l: 'Cold Storage', v: SEED.vault.cold, sub: 'Coldcard Q · Multisig' },
            { l: 'Lightning', v: SEED.vault.hot, sub: 'Phoenix · Self-custody' },
          ].map((h, i, arr) => (
            <React.Fragment key={h.l}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '14px 14px', gap: 12 }}>
                <div style={{ width: 6, height: 36, borderRadius: 3, background: t.accent, opacity: i === 0 ? 1 : 0.5 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{h.l}</div>
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>{h.sub}</div>
                </div>
                <Amount sats={h.v * SATS_PER_BTC} unit={unit} t={t} size={14} weight={700}/>
              </div>
              {i < arr.length - 1 && <Hairline t={t} indent={32}/>}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
}

Object.assign(window, {
  Card, Section, Hairline, Amount, Pill, ScreenHeader, UnitToggle,
  DashboardScreen, BudgetScreen, TransactionsScreen, AddTxnScreen,
  TodayScreen, ProjectsScreen, RetirementScreen, NetWorthScreen,
});
