// Barrel export for the Graphite Ledger Cockpit UI primitives.
// Pages import from here, never from individual component files.

export { AppShell, TopBar } from "./AppShell.tsx"
export type { AppShellProps, NavItem, NavSection, TopBarProps } from "./AppShell.tsx"

export { DataTable } from "./DataTable.tsx"
export type { Column, DataTableProps } from "./DataTable.tsx"

export { BudgetProgress } from "./BudgetProgress.tsx"
export type { BudgetProgressProps } from "./BudgetProgress.tsx"

export { DialogFrame } from "./DialogFrame.tsx"
export type { DialogFrameProps } from "./DialogFrame.tsx"

export {
  DeleteConfirmDialog,
  MutationNotice,
  RowActions,
  localMutationError,
} from "./CrudControls.tsx"

export {
  BillPayFormDialog,
  BtcAccountFormDialog,
  BtcBuyFormDialog,
  BudgetCategoryFormDialog,
  TodoFormDialog,
  TransactionFormDialog,
} from "./MutationForms.tsx"

export { FreshnessTag, LoadingBlock, StateBlock } from "./StateBlock.tsx"
export type { BlockState, StateBlockProps } from "./StateBlock.tsx"

export { ICON_NAMES, IconGlyph } from "./IconGlyph.tsx"
export type { IconGlyphProps, IconName } from "./IconGlyph.tsx"

export {
  Badge,
  Button,
  Field,
  KPIStrip,
  PageGrid,
  PageHeader,
  Panel,
  Select,
  StatusBanner,
  SUPPRESSED,
  TextInput,
  Toolbar,
} from "./primitives.tsx"
export type {
  BadgeProps,
  BadgeTone,
  BannerTone,
  ButtonProps,
  ButtonVariant,
  FieldProps,
  KPI,
  KPIStripProps,
  PageHeaderProps,
  PanelProps,
  Provenance,
  StatusBannerProps,
  ToolbarProps,
} from "./primitives.tsx"

export { cx } from "./cx.ts"
