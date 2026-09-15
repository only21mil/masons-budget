// Icon access by name, so pages never import lucide directly and the icon set
// stays auditable in one place.

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Bitcoin,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Download,
  Flag,
  FolderKanban,
  Inbox,
  Landmark,
  LayoutDashboard,
  Lock,
  type LucideIcon,
  PiggyBank,
  RefreshCw,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Wallet,
  X,
} from "lucide-react"

import { cx } from "./cx.ts"

const ICONS = {
  activity: Activity,
  alert: AlertTriangle,
  bank: Landmark,
  banknote: Banknote,
  bitcoin: Bitcoin,
  calendar: CalendarClock,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "circle-alert": CircleAlert,
  "circle-dashed": CircleDashed,
  dashboard: LayoutDashboard,
  home: LayoutDashboard,
  download: Download,
  flag: Flag,
  inbox: Inbox,
  lock: Lock,
  projects: FolderKanban,
  receipt: Receipt,
  refresh: RefreshCw,
  retirement: PiggyBank,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Sparkles,
  sun: Sun,
  today: Sun,
  "trend-down": ArrowDownRight,
  "trend-up": ArrowUpRight,
  users: Users,
  wallet: Wallet,
  x: X,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export interface IconGlyphProps {
  name: IconName
  size?: number
  className?: string
  /** Icons are decorative unless given a label. */
  label?: string
}

export function IconGlyph({ name, size = 16, className, label }: IconGlyphProps) {
  const Glyph = ICONS[name]
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={cx("vv-icon", className)}
      // An <svg> has no implicit role, so a bare aria-label on it is dropped by
      // several screen readers. role="img" is what makes the label reachable.
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
    />
  )
}

export const ICON_NAMES = Object.keys(ICONS) as IconName[]
