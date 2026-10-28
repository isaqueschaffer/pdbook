const PALETTES = [
  ["#2f4a3f", "#e9e2d0"],
  ["#5a3e36", "#f1e4d6"],
  ["#2d3e57", "#dfe6ef"],
  ["#6b4f1d", "#f3e8cf"],
  ["#4a3557", "#ece2f0"],
  ["#3d4a2a", "#e6ebd8"],
  ["#7a3b2e", "#f5e1da"],
  ["#264d4f", "#dcecec"],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A typographic cover generated from the title (PDFs do not carry a reliable cover image). */
export function BookCover({ id, title, author, className = "" }: { id: string; title: string; author?: string | null; className?: string }) {
  const [bg, fg] = PALETTES[hash(id) % PALETTES.length];
  return (
    <div
      className={`relative flex aspect-[2/3] flex-col justify-between overflow-hidden rounded-md p-3 shadow-[0_1px_2px_rgba(0,0,0,.12),0_6px_16px_-8px_rgba(0,0,0,.35)] ${className}`}
      style={{ background: bg, color: fg }}
      aria-hidden
    >
      <div className="absolute inset-y-0 left-0 w-1.5 bg-black/15" />
      <p className="line-clamp-5 font-serif text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]">{title}</p>
      {author && <p className="line-clamp-2 text-[10px] uppercase tracking-wider opacity-75">{author}</p>}
    </div>
  );
}
