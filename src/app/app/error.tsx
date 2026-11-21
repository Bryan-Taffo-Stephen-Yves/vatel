"use client";
import { Bitmoji } from "@/components/bitmoji";
import { useAppData } from "@/components/app/app-data";
import Link from "next/link";
import { RotateCcw, WifiOff } from "lucide-react";
import { useT } from "@/lib/i18n";

/** Une page qui plante n'arrête plus toute l'appli : message clair, la barre du bas reste utilisable. */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const { profile } = useAppData();
  const t = useT();
  return (
    <main className="px-4 pt-16 text-center">
      <span className="relative mx-auto block w-fit">
        <Bitmoji avatar={profile?.avatar} seed={profile?.id} mood="sad" className="size-24" />
        {offline && <span className="absolute -bottom-1 -right-1 grid size-9 place-items-center rounded-full bg-ink"><WifiOff className="size-4 text-lime" /></span>}
      </span>
      <h1 className="mt-4 text-xl font-extrabold">{offline ? t("Pas de connexion") : t("Cet écran n'a pas pu s'afficher")}</h1>
      <p className="mx-auto mt-1 max-w-xs text-sm text-muted">{offline ? t("Vos tickets et leurs QR restent disponibles dans « Mon QR ».") : t("Réessayez, ou revenez à l'accueil.")}</p>
      <div className="mt-6 flex justify-center gap-2">
        <button onClick={reset} className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white"><RotateCcw className="size-4" />{t("Réessayer")}</button>
        <Link href="/app/tickets" className="flex h-11 items-center rounded-full bg-lime px-5 text-sm font-bold">{t("Mon QR")}</Link>
      </div>
    </main>
  );
}
