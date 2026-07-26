// Generic ledger table.
//
// Dense by default, tabular numerals in numeric columns, and it delegates every
// non-normal state to StateBlock so a half-loaded table can never read as a
// complete one.

import type { ReactNode } from "react"

import { LoadingBlock, StateBlock } from "./StateBlock.tsx"
import { cx } from "./cx.ts"

export interface Column<Row> {
  readonly key: string
  readonly header: ReactNode
  readonly render: (row: Row) => ReactNode
  /** Right-align and use tabular numerals. */
  readonly numeric?: boolean
  readonly width?: string
  /** Hidden below the 1366 compact breakpoint. */
  readonly secondary?: boolean
}

export interface DataTableProps<Row> {
  columns: ReadonlyArray<Column<Row>>
  rows: readonly Row[]
  rowKey: (row: Row, index: number) => string
  state?: "normal" | "empty" | "error" | "stale" | "loading"
  emptyTitle?: string
  emptyDetail?: string
  onRetry?: () => void
  /** Rendered under the last row — totals, counts, a truncation notice. */
  footer?: ReactNode
  className?: string
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  state = "normal",
  emptyTitle,
  emptyDetail,
  onRetry,
  footer,
  className,
}: DataTableProps<Row>) {
  if (state === "loading") return <LoadingBlock rows={6} />
  if (state === "error") return <StateBlock state="error" onRetry={onRetry} />
  if (rows.length === 0) {
    return <StateBlock state="empty" title={emptyTitle} detail={emptyDetail} />
  }

  return (
    <div className={cx("vv-table-wrap", "vv-scroll", className)}>
      <table className="vv-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cx(
                  column.numeric && "vv-table__cell--num",
                  column.secondary && "vv-table__cell--secondary",
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    column.numeric && "vv-table__cell--num",
                    column.numeric && "vv-num",
                    column.secondary && "vv-table__cell--secondary",
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer ? <div className="vv-table__footer">{footer}</div> : null}
    </div>
  )
}
