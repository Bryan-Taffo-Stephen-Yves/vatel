"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Smartphone } from "lucide-react";
import { myId, supabase } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { TxDetail, PAYMENT_COLUMNS, METHOD_LABEL, type Payment } from "@/components/app/tx-detail";
import { useAppData } from "@/components/app/app-data";
import { useFamilyOverview } from "@/lib/family-cache";
import { fcfa, firstName, relativeDay, time, todayISO, TZ } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";

type Overview = { children: { id: string; name: string }[] };

/**
 * Historique d'un compte PARENT : les recharges qu'il a payées (réussies, en attente ou échouées), pour quel enfant,
 * par quel moyen. Toucher une ligne ouvre le détail (heure exacte, référence, numéro débité…).
 */
export function ParentHistory() {
  const t = useT();
  const en = useLang() === "en";
  const { profile } = useAppData();
  const { data: fam } = useFamilyOverview<Overview>(profile?.id);
  const [list, setList] = useState<Payment[] | null>(null);
  const [sel, setSel] = useState<Payment | null>(null);

  useEffect(() => {
    (async () => {
      const uid = await myId();
      if (!uid) return setList([]);
      const { data } = await supabase().from("payments").select(PAYMENT_COLUMNS)
        .eq("payer_id", uid).order("created_at", { ascending: false }).limit(100);
      setList((data as Payment[] | null) ?? []);
    })();
  }, []);

  const name = (id: string) => {
    if (id === profile?.id) return t("moi");
    const c = fam?.children.find((k) => k.id === id);
    return c ? firstName(c.name) : t("mon enfant");
  };
  const dayTitle = (iso: string) => {
    const r = relativeDay(iso);
    if (!en || ["Aujourd'hui", "Hier", "Demain"].includes(r)) return t(r);
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  };
  const ok = (list ?? []).filter((p) => p.status === "success");
  const month = ok.filter((p) => todayISO(new Date(p.created_at)).slice(0, 7) === todayISO().slice(0, 7));
  const groups = (list ?? []).reduce<Record<string, Payment[]>>((g, p) => {
    (g[todayISO(new Date(p.created_at))] ??= []).push(p);
    return g;
  }, {});

  return (
    <main>
      <PageHeader title="Historique" back={false} />
      <div className="px-4 pb-28">
        <div className="rounded-[24px] bg-ink p-5 text-white">
          <p className="text-sm font-bold text-white/60">{t("Rechargé ce mois-ci")}</p>
          <p className="mt-1 text-3xl font-extrabold">{fcfa(month.reduce((s, p) => s + p.amount, 0))}</p>
          <p className="mt-1 text-sm text-lime">{month.length} {t("recharges réussies")}</p>
        </div>

        {list === null && <div className="mt-4 h-64 animate-pulse rounded-[24px] bg-card" />}
        {list?.length === 0 && <p className="mt-6 text-center text-sm text-muted">{t("Aucune recharge pour l'instant.")}</p>}
        {Object.entries(groups).map(([day, items]) => (
          <section key={day} className="mt-5">
            <h2 className="mb-2 text-xs font-extrabold uppercase tracking-wider text-muted">{dayTitle(day)}</h2>
            <div className="divide-y divide-line overflow-hidden rounded-[22px] bg-card shadow-[var(--shadow-card)]">
              {items.map((p) => (
                <button key={p.id} onClick={() => setSel(p)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-canvas">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lime-soft text-lime-deep"><Smartphone className="size-[18px]" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{t("Recharge pour")} {name(p.beneficiary_id)}</p>
                    <p className="truncate text-xs text-muted">{time(p.created_at)} · {METHOD_LABEL[p.method] ?? p.method}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={clsx("text-sm font-extrabold", p.status === "error" ? "text-muted line-through" : "text-ink")}>{fcfa(p.amount)}</p>
                    <p className={clsx("text-[11px] font-bold", p.status === "success" ? "text-[#15803d]" : p.status === "pending" ? "text-[#92400e]" : "text-err")}>
                      {p.status === "success" ? t("Réussie") : p.status === "pending" ? t("En attente") : t("Échouée")}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <TxDetail payment={sel} childName={sel ? name(sel.beneficiary_id) : null} onClose={() => setSel(null)} />
    </main>
  );
}
