export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-ink ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M8 9.5c2.8-.9 5.4-.6 8 1v13c-2.6-1.6-5.2-1.9-8-1z" fill="var(--accent-ink)" />
        <path d="M24 9.5c-2.8-.9-5.4-.6-8 1v13c2.6-1.6 5.2-1.9 8-1z" fill="var(--accent-ink)" opacity=".7" />
      </svg>
      <span className="text-[17px]">BookFlow</span>
    </span>
  );
}
