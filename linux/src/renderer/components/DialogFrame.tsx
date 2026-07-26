// Modal frame built on <dialog>, so focus trapping, Escape, and the top layer
// come from the platform rather than a hand-rolled focus manager.

import { useEffect, useRef } from "react"
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
}

export function DialogFrame({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className,
}: DialogFrameProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Escape fires `cancel`; route it through onClose so state stays in sync.
    const handleCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener("cancel", handleCancel)
    return () => dialog.removeEventListener("cancel", handleCancel)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      className={cx("vv-dialog", className)}
      aria-label={typeof title === "string" ? title : undefined}
      onClick={(event) => {
        // Backdrop clicks land on the dialog element itself.
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="vv-dialog__inner">
        <header className="vv-dialog__head">
          <div>
            <h2 className="vv-dialog__title">{title}</h2>
            {description ? <p className="vv-dialog__description">{description}</p> : null}
          </div>
          <Button variant="ghost" icon="x" iconOnly onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="vv-dialog__body vv-scroll">{children}</div>
        {footer ? <footer className="vv-dialog__foot">{footer}</footer> : null}
      </div>
    </dialog>
  )
}
