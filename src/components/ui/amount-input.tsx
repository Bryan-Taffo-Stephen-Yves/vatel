"use client";
import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { fcfa } from "@/lib/format";

/**
 * Gros montant modifiable directement : on touche « 5 000 FCFA », le clavier chiffré s'ouvre sur un champ vide
 * (l'ancien montant reste affiché en gris), on tape le nouveau (ex. 3500) et c'est tout. Si on ne tape rien,
 * l'ancien montant reste. Les espaces des milliers reviennent en quittant le champ.
 * `onChange` reçoit les chiffres tapés ; `onDone` est appelé en quittant le champ.
 */
export function AmountInput({ value, onChange, onDone, hint, max = 6 }: {
  value: number; onChange: (digits: string) => void; onDone?: () => void; hint?: string; max?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null); // null = pas en cours de saisie
  const initial = useRef(value); // montant avant la saisie, remis si on efface tout
  const shown = draft ?? fcfa(value, false);
  const ph = draft !== null ? fcfa(value, false) : "0";
  return (
    <div>
      <label className="mt-1 flex cursor-text items-baseline justify-center gap-2 text-[42px] font-extrabold tracking-tight"
        onClick={() => ref.current?.focus()}>
        {/* Le champ prend exactement la largeur du texte (copie invisible dans la même case de grille) */}
        <span className="inline-grid">
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre border-b-2 px-1 tabular-nums">{shown || ph}</span>
          <input ref={ref} size={1} inputMode="numeric" pattern="[0-9]*" enterKeyHint="done" aria-label="Montant" placeholder={ph}
            value={shown}
            onFocus={() => { initial.current = value; setDraft(""); }}
            onBlur={() => { setDraft(null); onDone?.(); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, max);
              setDraft(d);
              onChange(d || String(initial.current));
            }}
            className="col-start-1 row-start-1 w-full min-w-0 border-b-2 border-dashed border-line bg-transparent px-1 text-center tabular-nums outline-none placeholder:text-line focus:border-ink" />
        </span>
        <span>FCFA</span>
      </label>
      {hint && (
        <button type="button" onClick={() => ref.current?.focus()}
          className="mx-auto mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
          <Pencil className="size-3.5" />{hint}
        </button>
      )}
    </div>
  );
}
