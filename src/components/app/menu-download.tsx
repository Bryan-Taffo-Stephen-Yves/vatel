"use client";
import { useEffect, useState } from "react";
import { Download, Images, Loader2 } from "lucide-react";
import { ChefArt, CloudBubble } from "@/components/chef";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useLang, useT } from "@/lib/i18n";
import { sfx } from "@/lib/sfx";
import type { Services } from "@/lib/menu";
import type { MenuItem } from "@/lib/types";

/**
 * Bandeau du menu : la cuisinière au fouet remue sa préparation (ingrédients qui sautent, vapeur),
 * un nuage annonce le menu, et un bouton enregistre le menu en IMAGE dans le téléphone.
 * Le dessin de l'image (lib/menu-image) n'est chargé qu'au toucher du bouton.
 */
export function MenuDownload({ day, days, items, services }: { day: string; days: string[]; items: MenuItem[]; services: Services | null }) {
  const t = useT();
  const lang = useLang();
  const en = lang === "en";
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [busy, setBusy] = useState<"day" | "week" | null>(null);

  const ofDay = items.filter((i) => i.service_date === day);
  const names = [...new Set(ofDay.filter((i) => i.service === "lunch").map((i) => i.dish.name))];
  const headline = names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? "…" : ""} 😋` : t("Le menu est servi ! 😋");

  const draw = async (d: string) => {
    const { menuImage } = await import("@/lib/menu-image");
    return menuImage({ date: d, items, services, lang });
  };
  const file = (b: Blob, d: string) => new File([b], `menu-dabali-${d}.jpg`, { type: "image/jpeg" });

  // Aperçu de l'image dès l'ouverture
  useEffect(() => {
    if (!open) return;
    let url = "";
    let live = true;
    draw(day).then((blob) => { if (!live) return; url = URL.createObjectURL(blob); setPreview({ url, blob }); })
      .catch(() => toast("err", t("Impossible de créer l'image du menu.")));
    return () => { live = false; if (url) URL.revokeObjectURL(url); setPreview(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, day]);

  async function save(which: "day" | "week") {
    setBusy(which);
    try {
      const { saveImages } = await import("@/lib/menu-image");
      const list = which === "day" ? [day] : days;
      const files = which === "day" && preview ? [file(preview.blob, day)] : await Promise.all(list.map(async (d) => file(await draw(d), d)));
      const r = await saveImages(files);
      if (r !== "cancelled") {
        sfx.success();
        toast("ok", r === "downloaded"
          ? (en ? "Menu saved in your Downloads 📲" : "Menu enregistré dans tes téléchargements 📲")
          : (en ? "Choose « Save image » to keep it in your gallery 📲" : "Choisis « Enregistrer l'image » pour le garder dans ta galerie 📲"));
      }
    } catch { toast("err", t("Impossible de créer l'image du menu.")); }
    setBusy(null);
  }

  return (
    <>
      {/* Bandeau compact (≈ 90 px) : animations jouées 3 fois puis arrêtées (batterie, fluidité) */}
      <section className="relative flex items-end gap-2 overflow-hidden rounded-[22px] bg-ink px-3 pb-2 pt-5 text-white shadow-[var(--shadow-card)]">
        <span className="cs-few relative h-[100px] shrink-0">
          <ChefArt who="fouet" className="chef-in origin-bottom" />
          {["🍅", "🌶️", "🧅"].map((e, i) => (
            <span key={e} aria-hidden className="chef-toss pointer-events-none absolute left-[55%] top-[22%] text-xs [animation-iteration-count:3]" style={{ animationDelay: `${i * 0.45}s` }}>{e}</span>
          ))}
        </span>
        <CloudBubble tail="left" className="chef-cloud mb-6 min-w-0 flex-1 [&>div]:px-3 [&>div]:py-2">
          <p className="truncate text-[13px] font-extrabold leading-snug">{headline}</p>
        </CloudBubble>
        <button onClick={() => { sfx.tap(); setOpen(true); }} aria-label={t("Télécharger le menu")}
          className="mb-6 flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px] font-extrabold text-ink transition active:scale-95">
          <Download className="size-4" />{t("Menu")}
        </button>
      </section>

      <Sheet open={open} onClose={() => setOpen(false)} title={t("Le menu en image")}>
        <p className="-mt-1 text-sm text-muted">{t("Garde-le dans ta galerie : tu le regardes sans ouvrir l'appli, même sans connexion.")}</p>
        <div className="mx-auto mt-3 grid max-h-[46vh] w-fit place-items-center overflow-hidden rounded-2xl bg-canvas shadow-inner">
          {preview
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={preview.url} alt={t("Aperçu du menu")} className="max-h-[46vh] w-auto" />
            : <span className="grid h-64 w-40 place-items-center"><Loader2 className="size-6 animate-spin text-muted" /></span>}
        </div>
        <div className="mt-4 space-y-2">
          <Button block size="lg" variant="dark" loading={busy === "day"} disabled={!preview || !!busy} onClick={() => save("day")}>
            <Download className="size-5" />{t("Enregistrer ce jour")}
          </Button>
          {days.length > 1 && (
            <Button block variant="ghost" loading={busy === "week"} disabled={!!busy} onClick={() => save("week")}>
              <Images className="size-5" />{en ? `The whole week (${days.length} images)` : `Toute la semaine (${days.length} images)`}
            </Button>
          )}
        </div>
      </Sheet>
    </>
  );
}
