"use client";
import { useEffect } from "react";
import clsx from "clsx";
import { useT } from "@/lib/i18n";
import type { ChefWho } from "@/lib/chefs-svg";
import type { Mood } from "@/lib/bitmoji";

/**
 * L'équipe de la cantine (bitmojis 2D, corps entier, dessinés en SVG dans lib/chefs-svg) : une cuisinière ou
 * le chef apparaît selon l'étape de la commande, avec son geste de cuisine animé. Aucune image à télécharger.
 */
export type ChefScene = "received" | "preparing" | "ready" | "done" | "cancelled" | "expired" | "denied" | "thanks" | "sorry";

const SCENES: Record<ChefScene, { who: ChefWho; mood: Mood; msg: string; badge: string; no?: boolean }> = {
  received: { who: "louche", mood: "happy", msg: "C'est noté ! Ta commande est arrivée en cuisine.", badge: "📝" },
  preparing: { who: "fouet", mood: "happy", msg: "Je prépare ton plat…", badge: "🔥" },
  ready: { who: "cupcakes", mood: "laugh", msg: "C'est prêt ! Passe au comptoir.", badge: "🍽️" },
  done: { who: "chef", mood: "yum", msg: "Bon appétit !", badge: "😋" },
  cancelled: { who: "chef", mood: "sad", msg: "Commande annulée. Ton argent t'est rendu.", badge: "🙅🏾‍♂️", no: true },
  expired: { who: "chef", mood: "sad", msg: "Pas récupérée à temps… le plat est perdu.", badge: "⌛", no: true },
  denied: { who: "chef", mood: "sad", msg: "", badge: "✋🏾", no: true },
  thanks: { who: "cupcakes", mood: "laugh", msg: "Merci ! La cuisine va être ravie.", badge: "💚" },
  sorry: { who: "chef", mood: "sad", msg: "Merci de nous le dire, on s'améliore.", badge: "🙏🏾" },
};

/** Mascottes retirées (demande du 21/11 : appli plus légère) : ne dessine plus rien. Gardé pour ne pas casser les imports. */
export function ChefArt(props: { who: ChefWho; mood?: Mood; anim?: boolean; className?: string }) {
  void props;
  return null;
}

/**
 * Message de la cuisine au centre de l'écran (carte simple, sans mascotte ni animation).
 * Se ferme d'un toucher ou toute seule après quelques secondes. `backdrop` : couleur du voile.
 */
export function ChefPopup({ scene, message, sub, backdrop, onClose, autoClose, children }: {
  scene: ChefScene; message?: React.ReactNode; sub?: React.ReactNode; backdrop?: string;
  onClose?: () => void; autoClose?: number; children?: React.ReactNode;
}) {
  const t = useT();
  const s = SCENES[scene];
  useEffect(() => {
    if (!autoClose || !onClose) return;
    const id = setTimeout(onClose, autoClose);
    return () => clearTimeout(id);
  }, [autoClose, onClose, scene]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-6" onClick={onClose} role="status" aria-live="polite">
      <div className={clsx("absolute inset-0", (backdrop ?? "bg-ink/45").replace(/backdrop-blur-\S+/g, ""))} />
      {children}
      <div className="relative w-full max-w-[320px] rounded-[28px] bg-white px-6 py-6 text-center text-ink shadow-xl">
        <span className="text-4xl" aria-hidden>{s.badge}</span>
        <p className="mt-2 text-[19px] font-extrabold leading-snug">{message ?? t(s.msg)}</p>
        {sub && <div className="mt-1.5 text-sm font-semibold text-ink-2">{sub}</div>}
      </div>
    </div>
  );
}

/** Bulle de texte (carte blanche simple). */
export function CloudBubble({ children, className }: { children: React.ReactNode; className?: string; tail?: "down" | "left" | "none" }) {
  return <div className={clsx("rounded-[24px] bg-white px-5 py-4 text-center text-ink shadow-md", className)}>{children}</div>;
}
