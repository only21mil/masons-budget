// Modal frame built on <dialog>, so focus trapping, Escape, and the top layer
// come from the platform rather than a hand-rolled focus manager.

import { useEffect, useId, useRef } from "react"
import type { ReactNode } from "react"

import { Button } from "./primitives.tsx"
import { cx } from "./cx.ts"

export interface DialogFrameProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
  busy?: boolean
}

export function DialogFrame({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className,
  busy = false,
}: DialogFrameProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // Point at the rendered heading rather than stringifying the title: aria-label
  // only worked for a string title, so any ReactNode title left the dialog with
  // no accessible name whatsoever.
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      const first =
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        dialog.querySelector<HTMLElement>("input, select, button")
      first?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Escape fires `cancel`; route it through onClose so state stays in sync.
    const handleCancel = (event: Event) => {
      event.preventDefault()
      if (!busy) onClose()
    }
    dialog.addEventListener("cancel", handleCancel)
    return () => dialog.removeEventListener("cancel", handleCancel)
  }, [busy, onClose])

  return (
    <dialog
      ref={ref}
      className={cx("vv-dialog", className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        // Backdrop clicks land on the dialog element itself.
        if (!busy && event.target === ref.current) onClose()
      }}
    >
      <div className="vv-dialog__inner">
        <header className="vv-dialog__head">
          <div>
            <h2 className="vv-dialog__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="vv-dialog__description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" icon="x" iconOnly onClick={onClose} disabled={busy}>
            Close
          </Button>
        </header>
        <div className="vv-dialog__body vv-scroll">{children}</div>
        {footer ? <footer className="vv-dialog__foot">{footer}</footer> : null}
      </div>
    </dialog>
  )
}
