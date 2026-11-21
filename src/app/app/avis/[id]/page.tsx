"use client";
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Camera, MessageCircleReply, X } from "lucide-react";
import { edge, rpc, supabase, myId } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { DishImage } from "@/components/app/dish-image";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { COMPLAINTS, MOODS, complaintLabel, compressPhoto, moodEmoji, reviewPhotoUrl } from "@/lib/reviews";
import { ChefPopup } from "@/components/chef";
import { sfx } from "@/lib/sfx";
import { confetti } from "@/lib/confetti";
import { dateTime, SERVICE_LABEL, TZ } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import type { ServiceKind } from "@/lib/types";

type T = { id: string; service: ServiceKind; used_at: string | null; status: string; dish: { name: string; photo_url: string | null } | null };
type Review = { id: string; stars: number; comment: string | null; complaints: string[]; photo_path: string | null; reply: string | null; replied_at: string | null; created_at: string };


/** Avis sur un repas : note en émotions (😡 → 😍), plainte en un clic, commentaire, photo facultative. */
export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const tr = useT();
  const lang = useLang();
  const when = (ts: string) => lang === "en"
    ? new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ })
    : dateTime(ts);
  const fileRef = useRef<HTMLInputElement>(null);
  const [t, setT] = useState<T | null | undefined>(undefined);
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  const [stars, setStars] = useState(0);
  const [complaints, setComplaints] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pops, setPops] = useState(0); // relance les petits emojis qui s'envolent à chaque choix
  const [done, setDone] = useState<{ stars: number; msg: string } | null>(null); // écran de réaction après l'envoi

  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get("stars"));
    if (q >= 1 && q <= 5) { setStars(q); setPops(1); }
    const sb = supabase();
    sb.from("tickets").select("id, service, used_at, status, dish:dishes(name, photo_url)").eq("id", id).maybeSingle()
      .then(({ data }) => setT(data as unknown as T | null));
    sb.rpc("my_review", { p_ticket_id: id }).then(({ data }) => setReview((data as Review | null) ?? null));
  }, [id]);

  function toggle(c: string) { setComplaints((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c])); }

  async function pick(f: File | undefined) {
    if (!f) return;
    try {
      const b = await compressPhoto(f);
      setPhoto(b);
      setPreview(URL.createObjectURL(b));
    } catch { toast("err", tr("Photo illisible.")); }
  }

  async function send() {
    if (!stars) return toast("err", tr("Choisis une note."));
    setBusy(true);
    let path: string | null = null;
    if (photo) {
      const sb = supabase();
      path = `${await myId()}/${id}-${Date.now()}.jpg`;
      const { error } = await sb.storage.from("reviews").upload(path, photo, { contentType: "image/jpeg", upsert: false });
      if (error) { setBusy(false); return toast("err", tr("Envoi de la photo impossible.")); }
    }
    const r = await rpc<{ alert: boolean }>("rate_ticket", { p_ticket_id: id, p_stars: stars, p_comment: comment || null, p_complaints: complaints, p_photo_path: path });
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    // Photo de l'assiette : l'IA mesure ce qui n'a pas été mangé (en arrière-plan, l'élève n'attend pas)
    if (path) edge("plate-scan", { ticket_id: id, photo_path: path }).catch(() => {});
    // Réaction plein écran : pluie d'emojis contents, ou chef qui prend note si c'était raté
    setDone({ stars, msg: tr(r.alert ? "Merci. La cuisine est prévenue tout de suite." : path ? "Merci ! Ta photo aide la cuisine à ajuster les portions 🌱" : "Merci pour ton avis !") });
    sfx.mood(stars);
    if (stars >= 4) setTimeout(() => { sfx.success(); if (stars === 5) confetti(); }, 250);
    setTimeout(() => router.replace("/app/tickets"), 2300);
  }

  async function skip() {
    await rpc("dismiss_review", { p_ticket_id: id });
    router.replace("/app");
  }

  if (t === undefined || review === undefined) return <main><PageHeader title="Ton avis" /><div className="mx-4 h-80 animate-pulse rounded-[24px] bg-card" /></main>;
  if (!t || !t.dish) return <main><PageHeader title="Ton avis" /><p className="px-6 py-16 text-center text-sm text-muted">{tr("Ce repas ne peut pas être noté.")}</p></main>;

  return (
    <main className="pb-6">
      <PageHeader title="Ton avis" />
      <div className="px-4">
        <div className="overflow-hidden rounded-[24px] bg-card shadow-[var(--shadow-card)]">
          <DishImage name={t.dish.name} src={t.dish.photo_url} rounded="rounded-none" className="h-40 w-full" />
          <div className="p-4">
            <p className="text-xl font-extrabold">{t.dish.name}</p>
            <p className="text-sm text-muted">{tr(SERVICE_LABEL[t.service] ?? t.service)}{t.used_at ? ` · ${lang === "en" ? "served on" : "servi le"} ${when(t.used_at)}` : ""}</p>
          </div>
        </div>

        {review ? (
          // Avis déjà donné : récapitulatif + réponse de la cuisine
          <div className="mt-4 space-y-3">
            <div className="rounded-[22px] bg-card p-4 shadow-[var(--shadow-card)]">
              <p className="flex items-center gap-2 text-sm font-bold text-ink-2"><span className="text-4xl">{moodEmoji(review.stars)}</span>{tr(MOODS[review.stars - 1]?.label ?? "")}</p>
              {review.complaints.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">{review.complaints.map((c) => <span key={c} className="rounded-full bg-err-soft px-2.5 py-1 text-xs font-bold text-err">{tr(complaintLabel(c))}</span>)}</div>
              )}
              {review.comment && <p className="mt-2 text-sm">« {review.comment} »</p>}
              {review.photo_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={reviewPhotoUrl(review.photo_path)!} alt={tr("Ta photo")} loading="lazy" className="mt-3 max-h-64 w-full rounded-2xl object-cover" />
              )}
              <p className="mt-2 text-xs text-muted">{lang === "en" ? "Sent on" : "Envoyé le"} {when(review.created_at)}</p>
            </div>
            {review.reply ? (
              <div className="rounded-[22px] bg-ink p-4 text-white">
                <p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-lime"><MessageCircleReply className="size-4" />{tr("Réponse de la cuisine")}</p>
                <p className="mt-2 text-sm">{review.reply}</p>
                {review.replied_at && <p className="mt-1.5 text-xs text-white/50">{when(review.replied_at)}</p>}
              </div>
            ) : (
              <p className="px-1 text-sm text-muted">{tr("La cuisine lit tous les avis. Tu seras prévenu(e) si elle te répond.")}</p>
            )}
          </div>
        ) : (
          <>
            <div className={clsx("mt-4 rounded-[22px] p-5 text-center shadow-[var(--shadow-card)] transition-colors duration-300",
              stars === 0 ? "bg-card" : stars <= 2 ? "bg-err-soft" : stars === 3 ? "bg-warn-soft" : "bg-lime-soft")}>
              <p className="font-bold">{tr("Comment c'était ?")}</p>
              <div className="mt-3 flex justify-center gap-1" role="radiogroup" aria-label={tr("Comment c'était ?")}>
                {MOODS.map((m) => {
                  const on = stars === m.n;
                  return (
                    <button key={m.n} role="radio" aria-checked={on} aria-label={tr(m.label)}
                      onClick={() => { setStars(m.n); setPops((k) => k + 1); sfx.mood(m.n); }}
                      className={clsx("relative grid size-14 place-items-center rounded-full text-[34px] leading-none transition", on ? "bg-white shadow-md" : stars ? "opacity-45 grayscale-[60%]" : "active:scale-90")}>
                      <span key={on ? pops : 0} className={clsx("block", on && "mood-pick")}>{m.emoji}</span>
                      {/* petits emojis qui s'envolent quand on choisit */}
                      {on && pops > 0 && [-26, 4, 30].map((dx, i) => (
                        <span key={`${pops}-${i}`} aria-hidden className="mood-float pointer-events-none absolute left-1/2 top-0 -ml-3 text-2xl"
                          style={{ "--dx": `${dx}px`, "--rot": `${dx}deg`, animationDelay: `${i * 0.08}s` } as React.CSSProperties}>{m.emoji}</span>
                      ))}
                    </button>
                  );
                })}
              </div>
              <p key={stars} className="animate-pop mt-2 h-6 text-base font-extrabold">{stars ? tr(MOODS[stars - 1].label) : ""}</p>
            </div>

            <div className="mt-3 rounded-[22px] bg-card p-4 shadow-[var(--shadow-card)]">
              <p className="font-bold">{tr("Un souci ?")} <span className="text-sm font-semibold text-muted">{tr("facultatif")}</span></p>
              <div className="mt-3 flex flex-wrap gap-2">
                {COMPLAINTS.map((c) => (
                  <button key={c.code} onClick={() => toggle(c.code)}
                    className={clsx("rounded-full border px-3 py-1.5 text-sm font-semibold transition",
                      complaints.includes(c.code) ? (c.code === "corps_etranger" ? "border-err bg-err text-white" : "border-ink bg-ink text-white") : "border-line bg-canvas")}>
                    {c.emoji} {tr(c.label)}
                  </button>
                ))}
              </div>
              <textarea value={comment} onChange={(e) => setComment(e.target.value.slice(0, 500))} rows={3}
                placeholder={tr("Un mot pour la cuisine (facultatif)")}
                className="mt-3 w-full rounded-2xl border border-line bg-canvas px-3 py-2.5 text-sm outline-none focus:border-ink" />

              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              {preview ? (
                <div className="relative mt-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={preview} alt={tr("Aperçu")} className="max-h-56 w-full rounded-2xl object-cover" />
                  <button onClick={() => { setPhoto(null); setPreview(null); }} aria-label={tr("Retirer la photo")}
                    className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-ink/70 text-white"><X className="size-4" /></button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line py-3 text-sm font-bold text-ink-2">
                  <Camera className="size-5" />{tr("Ajouter une photo de mon assiette")}
                </button>
              )}
              <p className="mt-1.5 text-center text-xs font-semibold text-muted">{lang === "en"
                ? <>Optional · a photo of your plate <b>at the end of the meal</b> helps the kitchen measure what isn&apos;t eaten and adjust portions 🌱</>
                : <>Facultatif · une photo de ton assiette <b>à la fin du repas</b> aide la cuisine à mesurer ce qui n&apos;est pas mangé et à ajuster les portions 🌱</>}</p>
            </div>

            <Button block size="lg" variant="dark" className="mt-4" loading={busy} disabled={!stars} onClick={send}>{stars ? `${tr("Envoyer mon avis")} ${MOODS[stars - 1].emoji}` : tr("Envoyer mon avis")}</Button>
            <button onClick={skip} className="mt-3 w-full text-center text-sm font-bold text-muted">{tr("Ne pas noter ce repas")}</button>
          </>
        )}
      </div>
      {done && <Reaction stars={done.stars} msg={done.msg} />}
    </main>
  );
}

/** Après l'envoi : la mascotte au centre réagit dans sa bulle (pluie de 😍 si c'était bon, 😡 qui fulmine sinon) */
function Reaction({ stars, msg }: { stars: number; msg: string }) {
  const happy = stars >= 4, angry = stars <= 2;
  const e = MOODS[stars - 1].emoji;
  const rain = happy ? [e, "🤤", "💚", e, "✨", "😋", e, "👏🏾", e, "💚", "🍽️", e] : [];
  return (
    <ChefPopup scene={happy ? "thanks" : "sorry"} backdrop={happy ? "bg-lime/60 backdrop-blur-[3px]" : angry ? "bg-err/30 backdrop-blur-[3px]" : "bg-warn/30 backdrop-blur-[3px]"}
      message={<><span className={clsx("mood-big mb-1 block text-6xl leading-none", angry && "mood-fume")}>{e}</span>{msg}</>}>
      {rain.map((x, i) => (
        <span key={i} aria-hidden className="mood-rain pointer-events-none absolute top-0 text-3xl"
          style={{ left: `${(i * 83) % 100}%`, "--delay": `${(i % 6) * 0.12}s`, "--d": `${1.5 + (i % 4) * 0.25}s`, "--rot": `${i % 2 ? 200 : -160}deg` } as React.CSSProperties}>{x}</span>
      ))}
    </ChefPopup>
  );
}
