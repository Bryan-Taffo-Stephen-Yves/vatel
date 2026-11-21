"use client";
import { useEffect, useMemo } from "react";
import clsx from "clsx";
import { useT } from "@/lib/i18n";
import { chefSvg, type ChefWho } from "@/lib/chefs-svg";
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

/** Le dessin SVG d'un membre de l'équipe (corps entier), à la hauteur de son conteneur. */
export function ChefArt({ who, mood = "happy", anim = true, className }: { who: ChefWho; mood?: Mood; anim?: boolean; className?: string }) {
  const html = useMemo(() => chefSvg(who, mood, anim), [who, mood, anim]);
  return <span aria-hidden className={clsx("block h-full [&>svg]:h-full [&>svg]:w-auto", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Personnage seul, qui entre en sautant ; geste de cuisine propre à l'étape. */
export function ChefFigure({ scene, className }: { scene: ChefScene; className?: string }) {
  const s = SCENES[scene];
  return (
    <span key={scene} className={clsx("relative inline-block shrink-0", s.no && "cs-no", className)}>
      <ChefArt who={s.who} mood={s.mood} className="chef-in origin-bottom select-none" />
      <span className="chef-badge absolute -right-6 top-0 grid size-8 place-items-center rounded-full bg-white text-base shadow-md">{s.badge}</span>
      {scene === "preparing" && <span className="chef-steam pointer-events-none absolute left-[55%] top-[42%] text-lg">♨️</span>}
      {(scene === "ready" || scene === "thanks") && <><span className="chef-spark pointer-events-none absolute -left-1 top-[30%] text-base">✨</span>
        <span className="chef-spark pointer-events-none absolute right-1 top-[6%] text-sm" style={{ animationDelay: "0.5s" }}>✨</span></>}
    </span>
  );
}

/**
 * La cuisine te parle : la mascotte apparaît AU CENTRE de l'écran, petite, avec un message dans une bulle.
 * La page reste visible derrière (voile léger). Se ferme d'un toucher ou toute seule après quelques secondes.
 * `backdrop` : voile sombre par défaut ; l'écran de l'agent passe une couleur franche (vert = servi, rouge = refusé).
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
    <div className="fixed inset-0 z-50 grid place-items-center overflow-hidden px-6" onClick={onClose} role="status" aria-live="polite">
      <div className={clsx("chef-veil absolute inset-0", backdrop ?? "bg-ink/45 backdrop-blur-[3px]")} />
      {children}
      <div key={scene} className="relative flex w-full max-w-[300px] flex-col items-center">
        <CloudBubble className="chef-cloud w-full" tail="down">
          <p className="text-[19px] font-extrabold leading-snug">{message ?? t(s.msg)}</p>
          {sub && <div className="mt-1.5 text-sm font-semibold text-ink-2">{sub}</div>}
        </CloudBubble>
        <ChefFigure scene={scene} className="mt-7 h-64" />
      </div>
    </div>
  );
}

/**
 * Bulle de conversation en forme de NUAGE : des bosses blanches sur le haut et le bas,
 * et deux petites bulles qui mènent à la mascotte (tail). Une seule ombre pour tout le nuage.
 */
export function CloudBubble({ children, className, tail = "down" }: { children: React.ReactNode; className?: string; tail?: "down" | "left" | "none" }) {
  return (
    <div className={clsx("relative text-center text-ink [filter:drop-shadow(0_10px_18px_rgba(0,0,0,0.2))]", className)}>
      <span aria-hidden className="absolute inset-0">
        {/* bosses du haut */}
        <span className="absolute -top-3 left-[8%] size-10 rounded-full bg-white" />
        <span className="absolute -top-5 left-[30%] size-14 rounded-full bg-white" />
        <span className="absolute -top-4 left-[56%] size-12 rounded-full bg-white" />
        <span className="absolute -top-2 right-[6%] size-9 rounded-full bg-white" />
        {/* bosses du bas */}
        <span className="absolute -bottom-2.5 left-[16%] size-9 rounded-full bg-white" />
        <span className="absolute -bottom-3 right-[22%] size-10 rounded-full bg-white" />
        {/* petites bulles vers la mascotte */}
        {tail === "down" && <><span className="absolute -bottom-6 left-[46%] size-4 rounded-full bg-white" /><span className="absolute -bottom-10 left-[50%] size-2.5 rounded-full bg-white" /></>}
        {tail === "left" && <><span className="absolute -left-4 bottom-2 size-4 rounded-full bg-white" /><span className="absolute -left-7 bottom-0 size-2.5 rounded-full bg-white" /></>}
      </span>
      <div className="relative rounded-[30px] bg-white px-5 py-4">{children}</div>
    </div>
  );
}
