"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Phone, WifiOff, Clock } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { rpc, myId } from "@/lib/supabase/client";
import { readCache, writeCache } from "@/lib/offline";
import { queuedOrders } from "@/lib/offline-orders";

/** Numéro d'appel de Jean, gardé sur le téléphone (un appel passe sans Internet). */
function useJeanPhone() {
  const [call, setCall] = useState<string | null>(null);
  useEffect(() => {
    setCall(readCache<{ call: string | null }>("vatel:jean")?.call ?? null);
    if (!navigator.onLine) return;
    rpc<{ call: string | null; whatsapp: string | null }>("jean_contact").then((r) => {
      if (!r.ok && "code" in r) return;
      const c = r as unknown as { call: string | null; whatsapp: string | null };
      writeCache("vatel:jean", c); setCall(c.call ?? null);
    });
  }, []);
  return call;
}

/** Bandeau « Pas de connexion » : ce qui marche quand même, commandes en attente, et Jean au téléphone. */
export function OfflineBanner() {
  const en = useLang() === "en";
  const [off, setOff] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const jean = useJeanPhone();
  useEffect(() => {
    const f = () => setOff(!navigator.onLine);
    const q = () => myId().then((id) => setWaiting(queuedOrders(id).length));
    f(); q();
    window.addEventListener("online", f); window.addEventListener("offline", f);
    window.addEventListener("vatel:order-queue", q); window.addEventListener("storage", q);
    return () => {
      window.removeEventListener("online", f); window.removeEventListener("offline", f);
      window.removeEventListener("vatel:order-queue", q); window.removeEventListener("storage", q);
    };
  }, []);
  if (!off && !waiting) return null;
  return (
    <div className="sticky top-0 z-50 bg-ink px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-xs font-bold text-white" role="status">
      {off && (
        <div className="flex items-center gap-2">
          <WifiOff className="size-4 shrink-0 text-lime" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px]">{en ? "No connection" : "Pas de connexion"}</span>
            <span className="block font-semibold text-white/70">{en ? "QR, menu and orders still work: orders leave when the network is back." : "QR, menu et commandes marchent : la commande part au retour du réseau."}</span>
          </span>
          {jean && (
            <a href={`tel:${jean}`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-lime px-3 py-2 text-[12px] font-extrabold text-ink active:scale-95">
              <Phone className="size-3.5" />{en ? "Call Jean" : "Appeler Jean"}
            </a>
          )}
        </div>
      )}
      {waiting > 0 && (
        <Link href="/app/commander" className="mt-1.5 flex items-center gap-2 rounded-xl bg-white/10 px-2.5 py-1.5 text-[12px]">
          <Clock className="size-3.5 shrink-0 text-lime" />
          {en ? `${waiting} order${waiting > 1 ? "s" : ""} waiting to be sent` : `${waiting} commande${waiting > 1 ? "s" : ""} en attente d'envoi`}
        </Link>
      )}
    </div>
  );
}
