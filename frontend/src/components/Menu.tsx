import { useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "./ui";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

/** Small popover menu, closes on outside click and Escape. */
export function Menu({ trigger, items, label }: { trigger: ReactNode; items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex size-8 items-center justify-center rounded-lg text-ink-faint hover:bg-surface-2 hover:text-ink"
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          {items
            .filter((i) => !i.hidden)
            .map((item) => (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm disabled:opacity-40",
                  item.danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-surface-2",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
