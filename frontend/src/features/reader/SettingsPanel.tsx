import { RotateCcw } from "lucide-react";

import type { Preferences } from "../../services/types";

const THEMES: { value: Preferences["theme"]; label: string; bg: string; fg: string }[] = [
  { value: "light", label: "Claro", bg: "#fdfcf9", fg: "#24221e" },
  { value: "sepia", label: "Sépia", bg: "#f4ecd8", fg: "#4a3b2a" },
  { value: "dark", label: "Escuro", bg: "#151617", fg: "#d8d4cb" },
];

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums opacity-70">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--r-accent,var(--accent))]"
      />
    </label>
  );
}

/** Reading preferences controls. Shared by the reader drawer and the settings page. */
export function SettingsPanel({ prefs, update, reset }: { prefs: Preferences; update: (p: Partial<Preferences>) => void; reset: () => void }) {
  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Tema</legend>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => update({ theme: t.value })}
              aria-pressed={prefs.theme === t.value}
              className={`flex h-14 flex-col items-center justify-center rounded-lg border-2 text-xs font-medium transition ${
                prefs.theme === t.value ? "border-[var(--r-accent,var(--accent))]" : "border-transparent ring-1 ring-black/10"
              }`}
              style={{ background: t.bg, color: t.fg }}
            >
              <span className="font-serif text-base leading-none">Aa</span>
              {t.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Fonte</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["serif", "sans"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => update({ font_family: f })}
              aria-pressed={prefs.font_family === f}
              className={`h-11 rounded-lg border text-sm transition ${f === "serif" ? "font-serif" : "font-sans"} ${
                prefs.font_family === f ? "border-[var(--r-accent,var(--accent))] font-semibold" : "border-current/15 opacity-75 hover:opacity-100"
              }`}
            >
              {f === "serif" ? "Serifada" : "Sem serifa"}
            </button>
          ))}
        </div>
      </fieldset>

      <Slider label="Tamanho da fonte" value={prefs.font_size} min={12} max={40} step={1} display={`${prefs.font_size}px`} onChange={(v) => update({ font_size: v })} />
      <Slider
        label="Espaçamento entre linhas"
        value={prefs.line_height}
        min={1.2}
        max={2.4}
        step={0.05}
        display={prefs.line_height.toFixed(2)}
        onChange={(v) => update({ line_height: Math.round(v * 100) / 100 })}
      />
      <Slider
        label="Espaçamento entre parágrafos"
        value={prefs.paragraph_spacing}
        min={0}
        max={2.5}
        step={0.25}
        display={`${prefs.paragraph_spacing.toFixed(2)} em`}
        onChange={(v) => update({ paragraph_spacing: v })}
      />
      <Slider label="Margens" value={prefs.margin} min={0} max={96} step={4} display={`${prefs.margin}px`} onChange={(v) => update({ margin: v })} />
      <Slider label="Largura do texto" value={prefs.max_width} min={440} max={1100} step={20} display={`${prefs.max_width}px`} onChange={(v) => update({ max_width: v })} />

      <label className="flex cursor-pointer items-center justify-between text-sm">
        Justificar texto
        <input type="checkbox" checked={prefs.justify} onChange={(e) => update({ justify: e.target.checked })} className="size-4 accent-[var(--r-accent,var(--accent))]" />
      </label>

      <button type="button" onClick={reset} className="flex items-center gap-2 text-sm opacity-75 hover:opacity-100">
        <RotateCcw className="size-4" /> Restaurar padrão
      </button>
    </div>
  );
}
