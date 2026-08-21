// iOS app shell — wraps screens with iOS frame, tab bar, FAB, light/dark + unit toggle
const { useState: useIosState } = React;

function IOSTabBar({ active, setActive, t }) {
  const tabs = [
    { id: 'home', label: 'Home', icon: (c) => <BtcGlyph size={22} color={c} filled={false}/> },
    { id: 'budget', label: 'Budget', icon: (c) => <Bars size={22} color={c}/> },
    { id: 'today', label: 'Today', icon: (c) => <CheckCircle size={22} color={c} accent={c}/> },
    { id: 'retire', label: 'Stack', icon: (c) => <Vault size={22} color={c}/> },
    { id: 'more', label: 'More', icon: (c) => <Dots size={22} color={c}/> },
  ];
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
      paddingTop: 6, paddingBottom: 28,
      background: t.bg.includes('0B')
        ? 'linear-gradient(180deg, rgba(11,9,7,0) 0%, rgba(11,9,7,0.95) 50%)'
        : 'linear-gradient(180deg, rgba(250,248,244,0) 0%, rgba(250,248,244,0.95) 50%)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end' }}>
        {tabs.map(tab => {
          const on = active === tab.id;
          const c = on ? t.accent : t.textMuted;
          return (
            <button key={tab.id} onClick={() => setActive(tab.id)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 0',
            }}>
              {tab.icon(c)}
              <span style={{ fontSize: 10, fontWeight: 600, color: c, letterSpacing: '-0.01em' }}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Top bar — minimal, has unit toggle and theme toggle
function IOSTopBar({ t, unit, setUnit, dark, setDark, onAdd }) {
  return (
    <div style={{
      position: 'absolute', top: 54, left: 0, right: 0, zIndex: 25,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 14px',
    }}>
      {/* Avatar */}
      <div style={{
        width: 36, height: 36, borderRadius: 12,
        background: `linear-gradient(135deg, ${t.accent}, ${t.accentDeep})`,
        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, letterSpacing: '-0.02em',
        boxShadow: '0 2px 6px rgba(247,147,26,0.35)',
      }}>S</div>

      <UnitToggle unit={unit} setUnit={setUnit} t={t}/>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => setDark(!dark)} style={{
          width: 36, height: 36, borderRadius: 12, border: `1px solid ${t.border}`,
          background: t.surface, color: t.text, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {dark
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          }
        </button>
        <button onClick={onAdd} style={{
          width: 36, height: 36, borderRadius: 12, border: 'none',
          background: t.accent, color: '#fff', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 6px rgba(247,147,26,0.35)',
        }}>
          <Plus size={18} color="#fff"/>
        </button>
      </div>
    </div>
  );
}

function IOSApp({ dark, setDark, unit, setUnit, initialTab = 'home' }) {
  const t = dark ? TOKENS.dark : TOKENS.light;
  const [active, setActive] = useIosState(initialTab);
  const [addOpen, setAddOpen] = useIosState(false);

  let body;
  if (active === 'home')   body = <DashboardScreen    t={t} unit={unit} setUnit={setUnit}/>;
  if (active === 'budget') body = <BudgetScreen       t={t} unit={unit}/>;
  if (active === 'today')  body = <TodayScreen        t={t}/>;
  if (active === 'retire') body = <RetirementScreen   t={t} unit={unit}/>;
  if (active === 'more')   body = <ProjectsScreen     t={t}/>;

  return (
    <IOSDevice dark={dark}>
      <div style={{ height: '100%', background: t.bg, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <IOSTopBar t={t} unit={unit} setUnit={setUnit} dark={dark} setDark={setDark} onAdd={() => setAddOpen(true)}/>
        <div style={{ height: '100%', overflow: 'auto', paddingTop: 102 }}>
          {body}
        </div>
        <IOSTabBar active={active} setActive={setActive} t={t}/>
        {addOpen && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 100, background: t.bg }}>
            <AddTxnScreen t={t} unit={unit} onClose={() => setAddOpen(false)} onAdd={() => setAddOpen(false)}/>
          </div>
        )}
      </div>
    </IOSDevice>
  );
}

Object.assign(window, { IOSApp });
