"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Bell, ChevronRight, UserPlus, Wallet, AlertTriangle, ShieldCheck } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { useAppData } from "@/components/app/app-data";
import { WhatsAppLink } from "@/components/app/whatsapp-link";
import { fcfa, firstName, time } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";

type Meal = { at: string; dish: string; stars: number | null };
type Child = {
  link_id: string; status: "pending" | "active"; id: string; name: string; short_code: string; balance: number | null;
  allergies: string[] | null; meals: Meal[] | null; spent_week: number | null;
};
type Overview = { low_threshold: number; children: Child[] };

const when = (iso: string, en: boolean) => {
  const d = new Date(iso);
  const same = d.toLocaleDateString("fr-FR", { timeZone: "Africa/Abidjan" }) === new Date().toLocaleDateString("fr-FR", { timeZone: "Africa/Abidjan" });
  if (same) return en ? `today at ${time(iso)}` : `aujourd'hui à ${time(iso)}`;
  return d.toLocaleDateString(en ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", timeZone: "Africa/Abidjan" });
};

/**
 * Accueil d'un compte PARENT : il ne mange pas à la cantine, il suit et recharge son ou ses enfants.
 * En haut chaque enfant (solde, dernier repas, dépenses de la semaine) avec « Recharger » ; puis les alertes WhatsApp.
 */
export function ParentHome() {
  const { profile, unread } = useAppData();
  const t = useT();
  const en = useLang() === "en";
  const [o, setO] = useState<Overview | null>(null);
  const load = useCallback(() => rpc<Overview>("family_overview").then((r) => r.ok && setO(r as unknown as Overview)), []);
  useEffect(() => { load(); }, [load]);
  const kids = o?.children.filter((c) => c.status === "active") ?? [];
  const h = new Date().getUTCHours();

  return (
    <main className="px-4 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-[22px] font-extrabold">{en ? "Hello" : "Bonjour"} {firstName(profile?.full_name ?? "")} 👋</p>
          <p className="text-sm font-semibold text-muted">{h < 12 ? t("Bonne matinée") : h < 18 ? t("Bon après-midi") : t("Bonne soirée")} · {t("Espace parent")}</p>
        </div>
        <Link href="/app/notifications" aria-label={t("Notifications")} className="relative grid size-12 place-items-center rounded-full bg-card shadow-[var(--shadow-card)]">
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid size-5 place-items-center rounded-full bg-err text-[11px] font-bold text-white">{unread > 9 ? "9+" : unread}</span>}
        </Link>
      </header>

      {o === null && <div className="mt-5 h-48 animate-pulse rounded-[26px] bg-card" />}

      {kids.map((c) => {
        const low = c.balance != null && c.balance < o!.low_threshold;
        const last = c.meals?.[0];
        return (
          <section key={c.link_id} className="mt-5 overflow-hidden rounded-[26px] bg-card shadow-[var(--shadow-card)]">
            <div className="bg-lime p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-12 place-items-center rounded-2xl bg-ink text-xl font-extrabold text-lime">{c.name[0]}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-extrabold">{c.name}</p>
                  <p className="text-xs font-bold text-ink-2">{c.short_code}</p>
                </div>
              </div>
              <p className="mt-4 text-sm font-bold text-ink-2">{t("Solde de la cantine")}</p>
              <p className={clsx("text-[38px] font-extrabold leading-tight tracking-tight", low && "text-err")}>{fcfa(c.balance ?? 0)}</p>
              {low && <p className="flex items-center gap-1.5 text-sm font-bold text-err"><AlertTriangle className="size-4" />{t("Solde bas : pensez à recharger.")}</p>}
              <Link href={`/app/recharger?pour=${c.id}&nom=${encodeURIComponent(firstName(c.name))}&montant=5000`}
                className="mt-4 flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-extrabold text-white active:scale-[0.99]">
                <Wallet className="size-5 text-lime" />{t("Recharger")} {firstName(c.name)}
              </Link>
            </div>
            <div className="grid grid-cols-2 divide-x divide-line border-b border-line">
              <div className="p-4"><p className="text-xs font-bold text-muted">{t("Dépensé cette semaine")}</p><p className="text-lg font-extrabold">{fcfa(c.spent_week ?? 0)}</p></div>
              <div className="p-4"><p className="text-xs font-bold text-muted">{t("Repas (14 jours)")}</p><p className="text-lg font-extrabold">{c.meals?.length ?? 0}</p></div>
            </div>
            <Link href="/app/famille" className="flex items-center gap-3 p-4">
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-muted">{t("Dernier repas")}</span>
                <span className="block truncate font-bold">{last ? `🍽️ ${last.dish} · ${when(last.at, en)}` : t("Pas encore de repas")}</span>
              </span>
              <span className="flex items-center gap-1 text-sm font-bold text-muted">{t("Repas et stats")}<ChevronRight className="size-4" /></span>
            </Link>
          </section>
        );
      })}

      {o && kids.length === 0 && (
        <Link href="/app/famille" className="mt-5 block rounded-[26px] border-2 border-dashed border-line bg-card p-5">
          <p className="flex items-center gap-2 text-lg font-extrabold"><UserPlus className="size-5" />{t("Ajouter mon enfant")}</p>
          <p className="mt-1 text-sm text-muted">{t("Entrez son code Vatel (dans son profil, ex. DB-2026). Votre numéro WhatsApp doit être enregistré par l'école comme parent de cet élève.")}</p>
        </Link>
      )}
      {o && kids.length > 0 && (
        <Link href="/app/famille" className="mt-3 flex items-center justify-center gap-2 text-sm font-bold text-muted"><UserPlus className="size-4" />{t("Ajouter un autre enfant")}</Link>
      )}

      <section className="mt-6 rounded-[22px] bg-card shadow-[var(--shadow-card)]">
        <p className="flex items-center gap-2 px-4 pt-4 font-extrabold"><ShieldCheck className="size-[18px] text-lime-deep" />{t("Recevoir les alertes")}</p>
        <p className="px-4 text-sm text-muted">{t("Solde bas, plat signalé commandé : vous êtes prévenu sur WhatsApp et par notification.")}</p>
        <WhatsAppLink />
      </section>
    </main>
  );
}
