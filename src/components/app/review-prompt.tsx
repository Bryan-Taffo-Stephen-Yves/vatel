"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { rpc, supabase, myId } from "@/lib/supabase/client";
import { Sheet } from "@/components/ui/sheet";
import { DishImage } from "@/components/app/dish-image";
import { MOODS, type PendingReview } from "@/lib/reviews";
import { sfx } from "@/lib/sfx";
import { useLang, useT } from "@/lib/i18n";

const SEEN = "dabali:review-later";

/**
 * 15 min après le repas, la fenêtre « Comment était ton … ? » s'ouvre d'elle-même dans l'appli
 * (au retour dans l'appli, ou en direct si elle est ouverte quand la demande arrive).
 */
export function ReviewPrompt() {
  const router = useRouter();
  const path = usePathname();
  const t = useT();
  const lang = useLang();
  const [p, setP] = useState<PendingReview | null>(null);

  const check = useCallback(async () => {
    // Compte parent : jamais de ticket à noter
    try { if (JSON.parse(localStorage.getItem("dabali:me") ?? "null")?.profile?.is_parent) return; } catch {}
    const { data } = await supabase().rpc("pending_review");
    const r = data as PendingReview | null;
    let later: string[] = [];
    try { later = JSON.parse(sessionStorage.getItem(SEEN) ?? "[]"); } catch {}
    setP(r && !later.includes(r.ticket_id) ? r : null);
  }, []);

  useEffect(() => {
    check();
    const sb = supabase();
    let ch: ReturnType<typeof sb.channel> | undefined;
    myId().then((uid) => {
      if (!uid) return;
      const user = { id: uid };
      ch = sb.channel(`review-${user.id}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
          (e) => { if ((e.new as { type: string }).type === "rate_dish") check(); })
        .subscribe();
    });
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); if (ch) sb.removeChannel(ch); };
  }, [check]);

  if (!p || path.startsWith("/app/avis") || path.startsWith("/app/tickets/")) return null;

  const later = () => {
    try { sessionStorage.setItem(SEEN, JSON.stringify([...JSON.parse(sessionStorage.getItem(SEEN) ?? "[]"), p.ticket_id])); } catch {}
    setP(null);
  };
  const never = async () => { await rpc("dismiss_review", { p_ticket_id: p.ticket_id }); setP(null); };

  return (
    <Sheet open onClose={later}>
      <div className="text-center">
        <DishImage name={p.dish} src={p.photo_url} className="mx-auto size-24" rounded="rounded-3xl" />
        <h2 className="mt-3 text-xl font-extrabold">{lang === "en" ? <>How was your {p.dish.split(" ")[0].toLowerCase()}?</> : <>Comment était ton {p.dish.split(" ")[0].toLowerCase()} ?</>}</h2>
        <p className="text-sm text-muted">{t("Ton avis aide la cuisine à s'améliorer.")}</p>
        <div className="mt-4 flex justify-center gap-1.5">
          {MOODS.map((m) => (
            <button key={m.n} onClick={() => { sfx.mood(m.n); setP(null); router.push(`/app/avis/${p.ticket_id}?stars=${m.n}`); }}
              aria-label={t(m.label)} className="grid size-14 place-items-center rounded-full text-[34px] leading-none transition hover:scale-110 active:scale-125">
              {m.emoji}
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-center gap-6 text-sm font-bold text-muted">
          <button onClick={later}>{t("Plus tard")}</button>
          <button onClick={never}>{t("Ne pas noter")}</button>
        </div>
      </div>
    </Sheet>
  );
}
