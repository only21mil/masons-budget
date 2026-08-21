// macOS app — three-pane: nav | content. Uses native MacWindow chrome.
const { useState: useMacState } = React;

function MacApp({ dark, setDark, unit, setUnit, width = 1180, height = 760, initialNav = 'home' }) {
  const t = dark ? TOKENS.dark : TOKENS.light;
  const [nav, setNav] = useMacState(initialNav);

  // Custom mac sidebar with Bitcoin nav
  const navItems = [
    { id: 'home',     label: 'Dashboard',    icon: (c) => <BtcGlyph size={15} color={c}/> },
    { id: 'budget',   label: 'Budget',       icon: (c) => <Bars size={15} color={c}/> },
    { id: 'txns',     label: 'Activity',     icon: (c) => <Bolt size={15} color={c}/> },
    { id: 'retire',   label: 'Retirement',   icon: (c) => <Vault size={15} color={c}/> },
    { id: 'net',      label: 'Net Worth',    icon: (c) => <Target size={15} color={c}/> },
  ];

  const todoItems = [
    { id: 'today',    label: 'Today',        icon: (c) => <Target size={15} color={c}/>, count: 5 },
    { id: 'projects', label: 'Projects',     icon: (c) => <Inbox size={15} color={c}/>, count: 25 },
  ];

  const NavRow = ({ item, group }) => {
    const on = nav === item.id;
    return (
      <button onClick={() => setNav(item.id)} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', margin: '0 8px', borderRadius: 7,
        border: 'none', background: on ? t.accentSoft : 'transparent',
        cursor: 'pointer', textAlign: 'left',
        color: on ? t.accent : t.text,
        fontSize: 12.5, fontWeight: on ? 600 : 500, letterSpacing: '-0.01em',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro", system-ui',
      }}>
        {item.icon(on ? t.accent : t.textMuted)}
        <span style={{ flex: 1 }}>{item.label}</span>
        {item.count != null && (
          <span style={{ fontSize: 11, color: t.textFaint, fontVariantNumeric: 'tabular-nums' }}>{item.count}</span>
        )}
      </button>
    );
  };

  // Body content
  let body;
  const inner = { padding: '0 8px 28px' };
  if (nav === 'home')   body = <DashboardScreen    t={t} unit={unit} setUnit={setUnit}/>;
  if (nav === 'budget') body = <BudgetScreen       t={t} unit={unit}/>;
  if (nav === 'txns')   body = <TransactionsScreen t={t} unit={unit}/>;
  if (nav === 'retire') body = <RetirementScreen   t={t} unit={unit}/>;
  if (nav === 'net')    body = <NetWorthScreen     t={t} unit={unit}/>;
  if (nav === 'today')  body = <TodayScreen        t={t}/>;
  if (nav === 'projects') body = <ProjectsScreen   t={t}/>;

  return (
    <div style={{
      width, height, borderRadius: 14, overflow: 'hidden',
      background: t.bg, position: 'relative',
      boxShadow: '0 0 0 1px rgba(0,0,0,0.18), 0 24px 60px rgba(0,0,0,0.35)',
      display: 'flex', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", sans-serif',
    }}>
      {/* Sidebar */}
      <div style={{
        width: 220, flexShrink: 0,
        background: dark ? '#0F0D0A' : '#F0EDE6',
        borderRight: `1px solid ${t.border}`,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Traffic lights */}
        <div style={{ height: 40, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <MacTrafficLights/>
          <div style={{ flex: 1 }}/>
        </div>
        {/* Workspace switcher */}
        <div style={{ padding: '4px 8px 12px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 8px', borderRadius: 7,
            background: t.surface, border: `1px solid ${t.border}`,
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: `linear-gradient(135deg, ${t.accent}, ${t.accentDeep})`,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }}>S</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>Satoshi</div>
              <div style={{ fontSize: 10, color: t.textFaint }}>The Bitcoin Standard</div>
            </div>
            <ArrowDown size={10} color={t.textFaint}/>
          </div>
        </div>

        {/* Quick actions */}
        <div style={{ padding: '0 8px 12px' }}>
          <button style={{
            width: '100%', padding: '7px 10px', borderRadius: 8,
            background: t.accent, color: '#fff', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12.5, fontWeight: 600,
            boxShadow: '0 2px 6px rgba(247,147,26,0.35)',
          }}>
            <Plus size={13} color="#fff"/> New transaction
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.85, fontFamily: 'ui-monospace, monospace' }}>⌘N</span>
          </button>
        </div>

        <div style={{
          padding: '4px 16px 6px', fontSize: 10, fontWeight: 700,
          color: t.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Money</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {navItems.map(i => <NavRow key={i.id} item={i}/>)}
        </div>

        <div style={{
          padding: '14px 16px 6px', fontSize: 10, fontWeight: 700,
          color: t.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Tasks</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {todoItems.map(i => <NavRow key={i.id} item={i}/>)}
        </div>

        <div style={{
          padding: '14px 16px 6px', fontSize: 10, fontWeight: 700,
          color: t.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Projects</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px' }}>
          {SEED.projects.map(p => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 7,
              fontSize: 12.5, color: t.text,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }}/>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 11, color: t.textFaint }}>{p.count}</span>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }}/>

        {/* Footer — net worth + theme/unit */}
        <div style={{ padding: 10, borderTop: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 6px 6px' }}>Net worth</div>
          <div style={{ padding: '0 6px' }}>
            <Amount sats={SEED.net.btc * SATS_PER_BTC} unit={unit} t={t} size={18} weight={700}/>
            <div style={{ fontSize: 10.5, color: t.success, marginTop: 2, fontWeight: 600 }}>+8.2% past 30d</div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <UnitToggle unit={unit} setUnit={setUnit} t={t}/>
            <button onClick={() => setDark(!dark)} style={{
              width: 26, height: 26, borderRadius: 7, border: `1px solid ${t.border}`,
              background: t.surface, color: t.text, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: 'auto',
            }}>
              {dark
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>}
            </button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{
          height: 40, borderBottom: `1px solid ${t.border}`,
          padding: '0 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text, letterSpacing: '-0.01em' }}>
            {navItems.concat(todoItems).find(i => i.id === nav)?.label || 'Dashboard'}
          </div>
          <div style={{ flex: 1 }}/>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: t.surface2, padding: '4px 10px', borderRadius: 7,
            fontSize: 12, color: t.textMuted, minWidth: 220,
          }}>
            <Search size={12} color={t.textFaint}/>
            <span>Search transactions, tasks…</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 10, color: t.textFaint }}>⌘K</span>
          </div>
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', background: t.bg, paddingTop: 8 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { MacApp });
