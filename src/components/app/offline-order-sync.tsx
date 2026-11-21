"use client";
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { myId } from "@/lib/supabase/client";
import { flushOrders } from "@/lib/offline-orders";
import { syncTokens } from "@/lib/tickets";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { useLang } from "@/lib/i18n";
import { time } from "@/lib/format";
import { buzz } from "@/lib/confetti";

/** Envoie les commandes gardées hors ligne dès que le réseau revient (sur n'importe quelle page de l'appli). */
export function OfflineOrderSync() {
  const toast = useToast();
  const router = useRouter();
  const { refresh } = useAppData();
  const en = useLang() === "en";

  const run = useCallback(async () => {
    const uid = await myId();
    if (!uid) return;
    const res = await flushOrders(uid);
    if (!res.length) return;
    for (const r of res) {
      if (r.kind === "sent") {
        buzz([20, 60, 40]);
        toast("ok", en ? `Order sent ✅ #${r.order_no} · pick up at ${time(r.pickup_at).replace("h", ":")}` : `Commande envoyée ✅ n° ${r.order_no} · à récupérer à ${time(r.pickup_at)}`);
      } else {
        const what = r.code === "SOLD_OUT" ? (en ? "Dish sold out, choose something else." : "Plat épuisé, choisis autre chose.") : r.message;
        toast("err", `${en ? "Order not sent" : "Commande non envoyée"} (${r.order.summary}) : ${what}`);
      }
    }
    await Promise.all([refresh(), syncTokens()]);
    router.refresh();
  }, [toast, refresh, router, en]);

  useEffect(() => {
    run();
    const onVis = () => document.visibilityState === "visible" && run();
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVis);
    const id = setInterval(run, 30_000);
    return () => { window.removeEventListener("online", run); document.removeEventListener("visibilitychange", onVis); clearInterval(id); };
  }, [run]);
  return null;
}
