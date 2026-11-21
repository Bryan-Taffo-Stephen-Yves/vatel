"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, MessageCircle, XCircle } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { DishImage } from "@/components/app/dish-image";
import { BiometricConfirm } from "@/components/app/biometric-confirm";
import { Button } from "@/components/ui/button";
import { deny } from "@/lib/deny";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { buzz } from "@/lib/confetti";
import { syncTokens } from "@/lib/tickets";
import { fcfa, relativeDay, time } from "@/lib/format";
import { useT, useLang } from "@/lib/i18n";

type Line = { name: string; photo_url?: string | null; qty: number; price: number };
type Req = {
  status: "pending" | "done" | "cancelled"; pickup_at: string; expires_at: string; ticket_id: string | null; source: string;
  lines: Line[]; extras: Line[];
};

/** Commande préparée par Jean sur WhatsApp : le client la confirme ici avec son code PIN (jamais dans WhatsApp). */
export default function ConfirmOrder({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { refresh, profile } = useAppData();
  const t = useT();
  const lang = useLang();
  const en = lang === "en";
  const [req, setReq] = useState<Req | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc<Req>("order_request_view", { p_token: token }).then((r) => {
      if (!r.ok) { setReq(null); return; }
      const v = r as unknown as Req;
      setReq(v);
      if (v.status === "done" && v.ticket_id) router.replace(`/app/tickets/${v.ticket_id}`);
    });
  }, [token, router]);

  async function confirm(pin: string) {
    setBusy(true); setErr(null);
    const r = await rpc<{ ticket_id: string; order_no: number }>("confirm_order_request", { p_token: token, p_pin: pin });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "PIN_NOT_SET") { router.push(`/app/profil?pin=new&back=/app/confirmer/${token}`); return; }
      if (r.code === "ALLERGY_SEVERE" || /allergie grave/i.test(r.message)) deny(document.querySelector("main"));
      setErr(r.message); return;
    }
    buzz([20, 60, 40]); refresh();
    toast("ok", r.order_no ? (en ? `Order #${r.order_no} confirmed ✅` : `Commande n° ${r.order_no} confirmée ✅`) : t("Commande confirmée ✅"));
    await syncTokens();
    router.replace(`/app/tickets/${r.ticket_id}`);
  }

  async function cancel() {
    await rpc("cancel_order_request", { p_token: token });
    toast("ok", t("Demande annulée.")); router.replace("/app");
  }

  const expired = req && (req.status !== "pending" || new Date(req.expires_at).getTime() < Date.now());
  const total = [...(req?.lines ?? []), ...(req?.extras ?? [])].reduce((s, l) => s + l.qty * l.price, 0);
  const dishes = (req?.lines ?? []).reduce((s, l) => s + l.qty, 0);
  return (
    <main className="pb-10">
      <PageHeader title={t("Confirmer ma commande")} />
      <div className="px-4">
        {req === undefined && <div className="h-40 animate-pulse rounded-[24px] bg-card" />}
        {req === null && (
          <div className="rounded-[24px] border-2 border-dashed border-line p-8 text-center">
            <XCircle className="mx-auto size-10 text-err" />
            <p className="mt-2 font-bold">{t("Demande introuvable sur ce compte")}</p>
            <p className="mt-1 text-sm text-muted">{t("Vérifie que tu es connecté avec le même compte que celui lié à WhatsApp.")}</p>
          </div>
        )}
        {req && (
          <>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-muted"><MessageCircle className="size-4 text-[#128C7E]" />{req.source === "phone" ? t("Préparée par Jean au téléphone") : t("Préparée par Jean sur WhatsApp")}</p>
            <div className="mt-3 rounded-[24px] bg-card p-3 shadow-[var(--shadow-card)]">
              <ul className="space-y-2">
                {req.lines.map((l) => (
                  <li key={l.name} className="flex items-center gap-3">
                    <DishImage name={l.name} src={l.photo_url ?? null} className="size-14 shrink-0" />
                    <p className="min-w-0 flex-1 font-extrabold leading-tight">{l.qty > 1 && <span className="text-lime-deep">{l.qty} × </span>}{l.name}</p>
                    <p className="text-sm font-bold">{fcfa(l.qty * l.price)}</p>
                  </li>
                ))}
                {req.extras.map((e) => (
                  <li key={e.name} className="flex items-center justify-between gap-3 pl-2 text-sm font-bold text-ink-2">
                    <span>+ {e.qty > 1 ? `${e.qty} × ` : ""}{e.name}</span><span>{fcfa(e.qty * e.price)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <p className="flex items-center gap-1 text-sm font-bold text-lime-deep"><Clock className="size-4" />{en
                  ? `Pickup ${enDay(req.pickup_at.slice(0, 10))} at ${time(req.pickup_at).replace("h", ":")}${dishes > 1 ? ` · ${dishes} dishes` : ""}`
                  : `Retrait ${relativeDay(req.pickup_at.slice(0, 10)).toLowerCase()} à ${time(req.pickup_at)}${dishes > 1 ? ` · ${dishes} plats` : ""}`}</p>
                <p className="text-lg font-extrabold">{fcfa(total)}</p>
              </div>
            </div>
            {expired ? (
              <p className="mt-5 rounded-2xl bg-warn-soft px-4 py-3 text-center text-sm font-bold">{t("Cette demande a expiré ou a déjà été traitée. Redemande à Jean.")}</p>
            ) : (
              <>
                <p className="mb-3 mt-6 text-center text-sm font-semibold text-muted">{profile?.biometric_enabled ? t("Confirme et paie d'un regard.") : t("Tape ton code PIN pour confirmer et payer.")}</p>
                <BiometricConfirm enabled={!!profile?.biometric_enabled} mode="send" onConfirmed={confirm} pinError={err} busy={busy} />
                <Button variant="ghost" block className="mt-3 text-err" onClick={cancel}>{t("Ce n'est pas moi / annuler")}</Button>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** relativeDay en anglais, en minuscules pour la phrase (today / tomorrow / « Monday 9 November ») */
function enDay(iso: string) {
  const r = relativeDay(iso);
  if (r === "Aujourd'hui") return "today";
  if (r === "Demain") return "tomorrow";
  if (r === "Hier") return "yesterday";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Abidjan" });
}
