"use client";
import { useState } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { formatPhone, nextPhone } from "@/lib/phone";

/**
 * Champ numéro de téléphone (10 chiffres). `value` = chiffres seulement.
 * Pendant la saisie, le champ montre les chiffres SANS espaces : effacer, coller (même « +225 … ») ou corriger au milieu
 * marche normalement (avec des espaces insérés à chaque frappe, le curseur sautait et « retour arrière » sur un espace
 * ne faisait rien). Les espaces « 07 01 02 03 04 » reviennent quand on quitte le champ.
 */
export function PhoneInput({ value, onChange, invalid, placeholder = "07 01 02 03 04", className, ...rest }: {
  value: string; onChange: (digits: string) => void; invalid?: boolean; placeholder?: string; className?: string;
} & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  const [focused, setFocused] = useState(false);
  return (
    <div className={clsx("relative", className)}>
      <input {...rest} type="tel" inputMode="tel" autoComplete="tel" placeholder={placeholder}
        value={focused ? value : formatPhone(value)}
        onFocus={(e) => { setFocused(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); rest.onBlur?.(e); }}
        onChange={(e) => onChange(nextPhone(e.target.value, value))}
        className={clsx("h-12 w-full rounded-2xl border bg-card pl-4 pr-11 text-[16px] font-bold tracking-wide outline-none focus:border-ink",
          invalid ? "border-err" : "border-line")} />
      {value && (
        <button type="button" aria-label="Effacer le numéro" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange("")}
          className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-canvas text-muted active:bg-line">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
