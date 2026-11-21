"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Check, X, Wallet, ChevronRight, Share2, ShieldCheck } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { useAppData } from "@/components/app/app-data";
import { useToast } from "@/components/ui/toast";
import { fcfa, time } from "@/lib/format";
import { useLang, useT, type Lang } from "@/lib/i18n";

type Meal = { at: string; dish: string; stars: number | null };
type Child = { link_id: string; status: "pending" | "active"; id: string; name: string; balance: number | null; allergies: string[] | null; meals: Meal[] | null };
type Overview = { low_threshold: number; children: Child[]; parents: { link_id: string; status: "pending" | "active"; name: string }[] };

const APP = "https://dabalix.netlify.app";
const first = (n: string) => n.split(" ")[0];
const when = (iso: string, lang: Lang) => {
  const d = new Date(iso), today = new Date();
  const same = d.toLocaleDateString("fr-FR", { timeZone: "Africa/Abidjan" }) === today.toLocaleDateString("fr-FR", { timeZone: "Africa/Abidjan" });
  if (lang === "en") return same ? `today at ${time(iso)}` : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "Africa/Abidjan" });
  return same ? `aujourd'hui à ${time(iso)}` : d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", timeZone: "Africa/Abidjan" });
};

/**
 * La famille en un coup d'œil, sans changer de page :
 * - parent : chaque enfant (solde, dernier repas), bouton Recharger ;
 * - élève : qui suit son compte, demande à accepter ici même, ou bouton « Inviter mon parent » (lien WhatsApp).
 */
export function FamilyPeek({ invite = false }: { invite?: boolean }) {
  const { profile } = useAppData();
  const toast = useToast();
  const t = useT();
  const lang = useLang();
  const [o, setO] = useState<Overview | null>(null);
  const load = useCallback(() => rpc<Overview>("family_overview").then((r) => r.ok && setO(r as unknown as Overview)), []);
  useEffect(() => { load(); }, [load]);

  async function respond(link: string, accept: boolean) {
    const r = await rpc("family_respond", { p_link: link, p_accept: accept });
    if (!r.ok) return toast("err", r.message);
    toast("ok", t(accept ? "C'est fait : ton parent peut maintenant suivre ton compte." : "Demande refusée.")); load();
  }

  function share() {
    const code = profile?.short_code ?? "";
    const msg = lang === "en"
      ? `Hi! To follow my Dabali canteen account (top up, see my meals, get alerted when my balance is low): open this link and create your account. My code: ${code}\n${APP}/app/famille?code=${encodeURIComponent(code)}`
      : `Salut ! Pour suivre mon compte cantine Dabali (recharger, voir mes repas, être prévenu si mon solde baisse) : ouvre ce lien et crée ton compte. Mon code : ${code}\n${APP}/app/famille?code=${encodeURIComponent(code)}`;
    if (navigator.share) navigator.share({ text: msg }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
  }

  if (!o) return null;
  const children = o.children.filter((c) => c.status === "active");
  const pending = o.parents.filter((p) => p.status === "pending");
  const parents = o.parents.filter((p) => p.status === "active");
  if (!children.length && !pending.length && !parents.length && !invite) return null;

  return (
    <div className="mt-3 space-y-3">
      {/* Parent : mes enfants */}
      {children.map((c) => {
        const low = c.balance != null && c.balance < o.low_threshold;
        const last = c.meals?.[0];
        return (
          <section key={c.link_id} className="rounded-[22px] bg-card p-3.5 shadow-[var(--shadow-card)]">
            <Link href="/app/famille" className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-ink text-lg font-extrabold text-lime">{c.name[0]}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-extrabold">{first(c.name)} <span className="font-semibold text-muted">· {t("mon enfant")}</span></p>
                <p className="truncate text-xs font-semibold text-muted">
                  {last ? `🍽️ ${last.dish}, ${when(last.at, lang)}${last.stars ? ` · ⭐ ${last.stars}` : ""}` : t("Pas encore de repas cette semaine")}
                </p>
              </div>
              <div className="text-right">
                <p className={clsx("text-base font-extrabold", low && "text-err")}>{fcfa(c.balance ?? 0)}</p>
                {low && <p className="text-[11px] font-bold text-err">{t("solde bas")}</p>}
              </div>
              <ChevronRight className="size-5 shrink-0 text-off" />
            </Link>
            {low && (
              <Link href={`/app/famille?recharge=${c.id}`} className="mt-2.5 flex h-10 items-center justify-center gap-2 rounded-full bg-ink text-sm font-extrabold text-white">
                <Wallet className="size-4 text-lime" />{t("Recharger")} {first(c.name)}
              </Link>
            )}
          </section>
        );
      })}

      {/* Élève : demande d'un parent, à accepter ici */}
      {pending.map((p) => (
        <section key={p.link_id} className="rounded-[22px] border-2 border-lime bg-lime-soft p-3.5">
          <p className="text-sm font-extrabold">👨‍👩‍👧 {p.name} {t("veut suivre ton compte")}</p>
          <p className="text-xs font-semibold text-ink-2">{t("Il pourra recharger ton compte, voir tes repas et être prévenu si ton solde baisse.")}</p>
          <div className="mt-2.5 flex gap-2">
            <button onClick={() => respond(p.link_id, true)} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink text-sm font-extrabold text-white"><Check className="size-4 text-lime" />{t("Accepter")}</button>
            <button onClick={() => respond(p.link_id, false)} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-card text-sm font-extrabold"><X className="size-4" />{t("Refuser")}</button>
          </div>
        </section>
      ))}

      {/* Élève : parents liés */}
      {parents.length > 0 && (
        <Link href="/app/famille" className="flex items-center gap-3 rounded-[22px] bg-card p-3.5 shadow-[var(--shadow-card)]">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lime-soft"><ShieldCheck className="size-5 text-lime-deep" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold">{t("Suivi par")} {parents.map((p) => first(p.name)).join(lang === "en" ? " and " : " et ")}</p>
            <p className="truncate text-xs font-semibold text-muted">{t("Recharge ton compte et voit tes repas · tu peux retirer le lien")}</p>
          </div>
          <ChevronRight className="size-5 shrink-0 text-off" />
        </Link>
      )}

      {/* Élève sans parent lié : l'inviter en un message */}
      {invite && !children.length && !pending.length && !parents.length && profile?.role === "client" && (
        <button onClick={share} className="flex w-full items-center gap-3 rounded-[22px] border-2 border-dashed border-line p-3.5 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-canvas"><Share2 className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold">{t("Inviter mon parent")}</p>
            <p className="text-xs font-semibold text-muted">{t("Il recharge ton compte et il est prévenu si ton solde baisse.")}</p>
          </div>
          <ChevronRight className="size-5 shrink-0 text-off" />
        </button>
      )}
    </div>
  );
}
