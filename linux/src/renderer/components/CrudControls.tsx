import type { ReactNode } from "react"

import type {
  MutationControllerState,
  RendererMutationResult,
} from "../data/mutations.ts"
import { Button, StatusBanner } from "./primitives.tsx"
import { DialogFrame } from "./DialogFrame.tsx"

export function MutationNotice({
  notice,
  onRetry,
}: {
  notice: MutationControllerState["notice"]
  onRetry?: () => void
}) {
  if (!notice) return null
  return (
    <StatusBanner
      tone={notice.tone}
      title={notice.text}
      action={
        notice.tone === "warning" && onRetry ? (
          <Button icon="refresh" onClick={onRetry}>Retry refresh</Button>
        ) : undefined
      }
    />
  )
}

export function RowActions({
  label,
  onEdit,
  onDelete,
  editDisabled = false,
  deleteDisabled = false,
  pending = false,
  children,
}: {
  label: string
  onEdit: () => void
  onDelete: () => void
  editDisabled?: boolean
  deleteDisabled?: boolean
  pending?: boolean
  children?: ReactNode
}) {
  return (
    <div className="vv-row-actions" aria-busy={pending || undefined}>
      {children}
      <Button
        variant="ghost"
        onClick={onEdit}
        disabled={editDisabled || pending}
        aria-label={`Edit ${label}`}
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        onClick={onDelete}
        disabled={deleteDisabled || pending}
        aria-label={`Delete ${label}`}
      >
        Delete
      </Button>
    </div>
  )
}

export function DeleteConfirmDialog({
  open,
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean
  label: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <DialogFrame
      open={open}
      title={`Delete ${label}?`}
      description="This removes the persisted row. This action cannot be undone."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy} data-autofocus>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      <p>Confirm that you want to delete {label}.</p>
    </DialogFrame>
  )
}

export function localMutationError(result: RendererMutationResult): string | null {
  switch (result.status) {
    case "ok":
      return null
    case "disabled":
      return "Editing is not available for this item in this build."
    case "not-configured":
      return "Editing is not configured on this device."
    case "unauthorized":
      return "Your change was not authorized. Nothing was saved."
    case "missing":
      return "This item no longer exists. The latest rows will be reloaded."
    case "failed":
      return result.code === "conflict"
        ? "This item changed while you were editing it. Review the latest values."
        : result.code === "rejected"
          ? "The ledger rejected this change. Review the values and try again."
        : result.code === "PLAN_EXISTS"
          ? "A plan for that month already exists. Refresh to see it."
        : "The ledger could not be reached. Your change was rolled back; try again."
  }
}
