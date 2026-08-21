// Custom Bitcoin-themed iconography. Single stroke style, 24x24 viewBox.
// All icons accept {size, color} via props (or fall back).

const Icon = ({ children, size = 20, color = 'currentColor', strokeWidth = 1.6, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {children}
  </svg>
);

// The Bitcoin "₿" glyph — drawn as an icon (not text), in our visual language.
const BtcGlyph = ({ size = 20, color = '#F7931A', filled = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {filled && <circle cx="12" cy="12" r="11" fill={color} />}
    <g transform={filled ? 'translate(0 0)' : ''}>
      <path
        d="M9.4 6h4.2c1.7 0 3 1.1 3 2.7 0 1.4-1.0 2.4-2.4 2.7 1.7.2 2.9 1.3 2.9 2.9 0 1.7-1.4 2.9-3.3 2.9H9.4V6z"
        stroke={filled ? '#fff' : color} strokeWidth="1.6" strokeLinejoin="round" fill="none"
      />
      <path d="M9.4 11.4h4.2M9.4 11.4h4.6" stroke={filled ? '#fff' : color} strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M11.0 4.5v1.5M11.0 17.2v1.8M13.2 4.5v1.5M13.2 17.2v1.8" stroke={filled ? '#fff' : color} strokeWidth="1.6" strokeLinecap="round"/>
    </g>
  </svg>
);

// Sats — three-dot stack with a tick
const SatsGlyph = ({ size = 20, color = '#F7931A' }) => (
  <Icon size={size} color={color}>
    <circle cx="6" cy="12" r="1.4" fill={color}/>
    <circle cx="12" cy="12" r="1.4" fill={color}/>
    <circle cx="18" cy="12" r="1.4" fill={color}/>
    <path d="M3 17h18" />
    <path d="M3 7h18" />
  </Icon>
);

// Lightning bolt — for LN payments
const Bolt = ({ size = 20, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8z" fill="none" />
  </Icon>
);

// On-chain — block linked to block
const Chain = ({ size = 20, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <rect x="3" y="8" width="7" height="8" rx="1.5" />
    <rect x="14" y="8" width="7" height="8" rx="1.5" />
    <path d="M10 12h4" />
  </Icon>
);

// Vault — cold storage
const Vault = ({ size = 20, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 12v-1.5M12 12l1 1" />
    <path d="M3 8h2M19 8h2M3 16h2M19 16h2" />
  </Icon>
);

// Hot wallet — wallet
const Wallet = ({ size = 20, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5a2 2 0 0 1 0-4h13" />
    <circle cx="17" cy="14" r="1.3" fill={color} stroke="none"/>
  </Icon>
);

// Stack — for stacking sats
const Stack = ({ size = 20, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M3 6h18M5 10h14M7 14h10M9 18h6" />
  </Icon>
);

// Checkbox open + filled
const CheckCircle = ({ size = 22, color = 'currentColor', filled = false, accent = '#F7931A' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" stroke={filled ? accent : color} strokeWidth="1.6" fill={filled ? accent : 'none'}/>
    {filled && <path d="M7.5 12.4l3 3 6-6.8" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>}
  </svg>
);

// Flag — todo priority
const Flag = ({ size = 16, color = 'currentColor', filled = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 21V4M5 4h11l-2 4 2 4H5"/>
  </svg>
);

// Plus
const Plus = ({ size = 18, color = 'currentColor', strokeWidth = 1.8 }) => (
  <Icon size={size} color={color} strokeWidth={strokeWidth}>
    <path d="M12 5v14M5 12h14"/>
  </Icon>
);

// Search
const Search = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Icon>
);

// Filter
const Filter = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M3 5h18l-7 9v6l-4-2v-4L3 5z"/>
  </Icon>
);

// Dot menu
const Dots = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <circle cx="6" cy="12" r="1.2" fill={color} stroke="none"/>
    <circle cx="12" cy="12" r="1.2" fill={color} stroke="none"/>
    <circle cx="18" cy="12" r="1.2" fill={color} stroke="none"/>
  </Icon>
);

// Arrow up/down
const ArrowUp = ({ size = 14, color = 'currentColor' }) => (
  <Icon size={size} color={color} strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7"/></Icon>
);
const ArrowDown = ({ size = 14, color = 'currentColor' }) => (
  <Icon size={size} color={color} strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7"/></Icon>
);
const ArrowRight = ({ size = 14, color = 'currentColor' }) => (
  <Icon size={size} color={color} strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></Icon>
);

// Calendar
const Calendar = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <rect x="3.5" y="5" width="17" height="15" rx="2"/>
    <path d="M3.5 9h17M8 3v4M16 3v4"/>
  </Icon>
);

// Inbox
const Inbox = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M3 13l3-8h12l3 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/>
    <path d="M3 13h5l1 2h6l1-2h5"/>
  </Icon>
);

// Target / goal
const Target = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <circle cx="12" cy="12" r="8.5"/>
    <circle cx="12" cy="12" r="4.5"/>
    <circle cx="12" cy="12" r="1.2" fill={color} stroke="none"/>
  </Icon>
);

// Chart bars
const Bars = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <path d="M5 19V11M10 19V6M15 19v-9M20 19v-13"/>
  </Icon>
);

// Settings
const Cog = ({ size = 18, color = 'currentColor' }) => (
  <Icon size={size} color={color}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>
  </Icon>
);

// Category glyphs (used in budget rows)
const CatGlyph = ({ kind, size = 18, color = '#fff' }) => {
  switch (kind) {
    case 'fork':   return <Icon size={size} color={color}><path d="M7 3v8a2 2 0 0 0 2 2v8M7 3v6a2 2 0 0 1-2 2M9 3v6a2 2 0 0 0 2 2"/><path d="M17 3c-2 0-3 2-3 5s1 5 3 5v8"/></Icon>;
    case 'home':   return <Icon size={size} color={color}><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-7H10v7H4a1 1 0 0 1-1-1v-9z"/></Icon>;
    case 'plane':  return <Icon size={size} color={color}><path d="M21 12L3 19l3-7-3-7 18 7z"/></Icon>;
    case 'heart':  return <Icon size={size} color={color}><path d="M12 21s-7.5-4.5-9-9.5C2 7 5 4 8 4c2 0 3 1 4 2.5C13 5 14 4 16 4c3 0 6 3 5 7.5-1.5 5-9 9.5-9 9.5z"/></Icon>;
    case 'bolt':   return <Bolt size={size} color={color}/>;
    case 'wrench': return <Icon size={size} color={color}><path d="M14.7 6.3a4 4 0 0 1 5 5L17 14l3 3-3 3-3-3-2.7 2.7a4 4 0 0 1-5-5L9 12l-5-5L7 4l5 5 2.7-2.7z"/></Icon>;
    case 'gift':   return <Icon size={size} color={color}><rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8M12 8v13M8 8a2 2 0 1 1 0-4c2 0 4 4 4 4H8zM16 8a2 2 0 1 0 0-4c-2 0-4 4-4 4h4z"/></Icon>;
    case 'box':    return <Icon size={size} color={color}><path d="M21 8l-9 4-9-4 9-4 9 4z"/><path d="M3 8v9l9 4 9-4V8M12 12v9"/></Icon>;
    case 'doc':    return <Icon size={size} color={color}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6M8 14h8M8 18h5"/></Icon>;
    case 'cpu':    return <Icon size={size} color={color}><rect x="6" y="6" width="12" height="12" rx="1"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></Icon>;
    case 'vault':  return <Vault size={size} color={color}/>;
    case 'people': return <Icon size={size} color={color}><circle cx="9" cy="8" r="3"/><path d="M3 21c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M14 21c0-2 2-4 4.5-4S22 18 22 21"/></Icon>;
    default: return null;
  }
};

Object.assign(window, {
  Icon, BtcGlyph, SatsGlyph, Bolt, Chain, Vault, Wallet, Stack,
  CheckCircle, Flag, Plus, Search, Filter, Dots,
  ArrowUp, ArrowDown, ArrowRight, Calendar, Inbox, Target, Bars, Cog, CatGlyph,
});
