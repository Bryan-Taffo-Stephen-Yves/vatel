"use client";
import { use } from "react";
import { Logo } from "@/components/logo";
import { DeliveryTracker } from "@/components/delivery/tracker";

/** Suivi public d'une tournée d'achats (lien partagé dans le groupe WhatsApp) : pas de compte nécessaire. */
export default function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 pt-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Logo />
        <span className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs font-bold shadow-[var(--shadow-card)]">
          <span className="size-2 animate-pulse rounded-full bg-ok" />Suivi en direct
        </span>
      </div>
      <h1 className="mb-4 text-2xl font-extrabold">Courses de la cantine</h1>
      <DeliveryTracker token={token} />
    </main>
  );
}
