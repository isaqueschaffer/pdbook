import { AlertTriangle, CheckCircle2, Clock, Loader2, ScanText } from "lucide-react";

import type { Book } from "../../services/types";

export function StatusBadge({ book }: { book: Book }) {
  const job = book.job;
  switch (book.status) {
    case "pending":
      return (
        <Badge className="bg-surface-2 text-ink-soft">
          <Clock className="size-3" /> {job?.status === "retrying" ? "Nova tentativa agendada" : "Aguardando"}
        </Badge>
      );
    case "processing":
      return (
        <Badge className="bg-accent-soft text-accent">
          <Loader2 className="size-3 animate-spin" /> {job?.kind === "ocr" ? "OCR" : "Processando"}
          {job && job.progress > 0 ? ` ${job.progress}%` : "…"}
        </Badge>
      );
    case "ready":
      return (
        <Badge className="bg-success-soft text-success">
          <CheckCircle2 className="size-3" /> Pronto
        </Badge>
      );
    case "needs_ocr":
      return (
        <Badge className="bg-warning-soft text-warning">
          <ScanText className="size-3" /> Digitalizado
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-danger-soft text-danger">
          <AlertTriangle className="size-3" /> Falhou
        </Badge>
      );
  }
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}
