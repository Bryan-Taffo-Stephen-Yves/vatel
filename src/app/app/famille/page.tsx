"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { UserPlus, Wallet, Utensils, Star, Check, X, AlertTriangle, ShieldCheck, Salad } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { dateTime, fcfa } from "@/lib/format";
import { ALLERGIES, DIETS, allergenLabel } from "@/lib/diet";
import { useLang, useT } from "@/lib/i18n";
import { WhatsAppLink } from "@/components/app/whatsapp-link";
import { PushToggle } from "@/components/push-toggle";

type Child = { link_id: string; status: "pending" | "active"; id: string; name: string; short_code: string; balance: number | null;
  allergies: string[] | null; diets: string[] | null; spent_week: number | null;
  meals: { at: string; service: string; dish: string; total: number; stars: number | null }[] | null };
type Overview = { low_threshold: number; children: Child[]; parents: { link_id: string; status: "pending" | "active"; name: string }[] };

const AMOUNTS = [2000, 5000, 10000, 20000];

/** Famille : le parent suit et recharge le compte de son enfant ; l'enfant accepte ou retire le lien. */
export default function FamilyPage() {
  const toast = useToast();
  const t = useT();
  const en = useLang() === "en";
  const [o, setO] = useState<Overview | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recharge, setRecharge] = useState<Child | null>(null);
  const [amount, setAmount] = useState(5000);
  // Allergies posées par le parent (l'enfant ne peut pas les retirer)
  const [dietFor, setDietFor] = useState<Child | null>(null);
  const [pAll, setPAll] = useState<string[]>([]);
  const [pSev, setPSev] = useState<string[]>([]);
  const [childAll, setChildAll] = useState<string[]>([]);
  const [dietReady, setDietReady] = useState(false); // « Enregistrer » seulement après lecture réussie (sinon on effacerait tout)
  async function openDiet(c: Child) {
    setDietFor(c); setPAll([]); setPSev([]); setChildAll(c.allergies ?? []); setDietReady(false);
    const r = await rpc<{ allergies: string[]; parent_allergies: string[]; parent_severe: string[] }>("family_child_diet", { p_child: c.id });
    if (!r.ok) { setDietFor(null); return toast("err", r.message); }
    setPAll(r.parent_allergies); setPSev(r.parent_severe); setChildAll(r.allergies); setDietReady(true);
  }
  async function saveDiet() {
    if (!dietFor || !dietReady) return;
    setBusy(true);
    const r = await rpc("parent_set_child_diet", { p_child: dietFor.id, p_allergies: pAll, p_severe: pSev.filter((a) => pAll.includes(a)) });
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    toast("ok", en ? `${dietFor.name.split(" ")[0]}’s allergies saved. They’ve been notified.` : `Allergies de ${dietFor.name.split(" ")[0]} enregistrées. Il est prévenu.`); setDietFor(null); load();
  }

  const load = useCallback(() => rpc<Overview>("family_overview").then((r) => r.ok && setO(r as unknown as Overview)), []);
  useEffect(() => { load(); }, [load]);
  // Lien d'invitation (?code=DB-xxxx) : code prérempli ; depuis l'accueil (?recharge=id) : feuille de recharge ouverte
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("code")) setCode(q.get("code")!.toUpperCase());
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("recharge");
    const c = id && o?.children.find((x) => x.id === id && x.status === "active");
    if (c) { setAmount(5000); setRecharge(c); window.history.replaceState(null, "", "/app/famille"); }
  }, [o]);

  async function add() {
    setBusy(true);
    const r = await rpc<{ child: string; status: string }>("family_request", { p_child_code: code });
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    toast("ok", en
      ? (r.status === "active" ? `${r.child} is already linked.` : `Request sent to ${r.child}: they need to accept in their app.`)
      : (r.status === "active" ? `${r.child} est déjà lié.` : `Demande envoyée à ${r.child} : il doit accepter dans son appli.`));
    setCode(""); load();
  }
  async function respond(link: string, accept: boolean) {
    const r = await rpc("family_respond", { p_link: link, p_accept: accept });
    if (!r.ok) return toast("err", r.message);
    toast("ok", t(accept ? "Lien accepté." : "Demande refusée.")); load();
  }
  async function unlink(link: string) {
    const r = await rpc("family_unlink", { p_link: link });
    if (!r.ok) return toast("err", r.message);
    toast("ok", t("Lien retiré.")); load();
  }
  // Paiement réel (Jèko) sur la page Recharger, pour l'enfant
  function doRecharge() {
    if (!recharge) return;
    const q = new URLSearchParams({ pour: recharge.id, nom: recharge.name.split(" ")[0], montant: String(amount) });
    window.location.href = `/app/recharger?${q}`;
  }

  return (
    <main className="pb-28">
      <PageHeader title={t("Ma famille")} />
      <div className="space-y-4 px-4">
        {/* Demandes reçues (côté enfant) */}
        {o?.parents.filter((p) => p.status === "pending").map((p) => (
          <section key={p.link_id} className="rounded-[24px] border-2 border-lime bg-lime-soft p-4">
            <p className="font-extrabold">{p.name} {t("veut suivre ton compte")}</p>
            <p className="mt-0.5 text-sm text-ink-2">{t("Il pourra recharger ton compte, voir ton solde et ce que tu manges. Tu pourras retirer ce lien à tout moment.")}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => respond(p.link_id, true)}><Check className="size-4" />{t("Accepter")}</Button>
              <Button size="sm" variant="outline" onClick={() => respond(p.link_id, false)}><X className="size-4" />{t("Refuser")}</Button>
            </div>
          </section>
        ))}

        {/* Côté parent */}
        <section className="rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
          <p className="flex items-center gap-2 font-bold"><UserPlus className="size-[18px]" />{t("Suivre le compte de mon enfant")}</p>
          <p className="mt-0.5 text-sm text-muted">{t("Entrez son code Dabali (dans son profil, ex. DB-2026). Votre enfant accepte dans son appli.")}</p>
          <form onSubmit={(e) => { e.preventDefault(); add(); }} className="mt-3 flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="DB-0000" maxLength={10}
              className="h-11 min-w-0 flex-1 rounded-full border border-line bg-canvas px-4 font-bold tracking-wider outline-none focus:border-ink" aria-label={t("Code de l'enfant")} />
            <Button loading={busy && !recharge} disabled={code.length < 6}>{t("Ajouter")}</Button>
          </form>
        </section>

        {o === null && <div className="h-40 animate-pulse rounded-[24px] bg-card" />}

        {o?.children.map((c) => {
          const low = c.balance != null && c.balance < o.low_threshold;
          return (
            <section key={c.link_id} className="overflow-hidden rounded-[24px] bg-card shadow-[var(--shadow-card)]">
              <div className="flex items-center gap-3 p-4">
                <span className="grid size-11 place-items-center rounded-2xl bg-ink text-lg font-extrabold text-lime">{c.name[0]}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-extrabold">{c.name}</p>
                  <p className="text-xs text-muted">{c.short_code}{c.status === "pending" && ` · ${t("en attente de son accord")}`}</p>
                </div>
                {c.status === "active" && (
                  <div className="text-right">
                    <p className={clsx("text-lg font-extrabold", low && "text-err")}>{fcfa(c.balance ?? 0)}</p>
                    <p className="text-[11px] text-muted">{fcfa(c.spent_week ?? 0)} {t("cette semaine")}</p>
                  </div>
                )}
              </div>

              {c.status === "active" && (
                <>
                  {low && <p className="mx-4 mb-3 flex items-center gap-2 rounded-2xl bg-err-soft px-3 py-2 text-sm font-bold text-err"><AlertTriangle className="size-4" />{t("Solde bas : pensez à recharger.")}</p>}
                  {((c.allergies?.length ?? 0) + (c.diets?.length ?? 0)) > 0 && (
                    <p className="mx-4 mb-3 flex flex-wrap items-center gap-1.5 text-xs font-bold">
                      <ShieldCheck className="size-4 text-lime-deep" />
                      {c.diets?.map((d) => <span key={d} className="rounded-full bg-canvas px-2 py-0.5">{t(DIETS.find((x) => x.id === d)?.label ?? d)}</span>)}
                      {c.allergies?.map((a) => <span key={a} className="rounded-full bg-err-soft px-2 py-0.5 text-err">⚠️ {allergenLabel(a, en ? "en" : "fr")}</span>)}
                    </p>
                  )}
                  <div className="flex gap-2 px-4 pb-3">
                    <Button className="flex-1" onClick={() => { setAmount(5000); setRecharge(c); }}><Wallet className="size-4" />{t("Recharger son compte")}</Button>
                    <Button variant="outline" onClick={() => openDiet(c)}><Salad className="size-4" />{t("Allergies")}</Button>
                  </div>
                  <div className="border-t border-line px-4 py-3">
                    <p className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-muted"><Utensils className="size-3.5" />{t("Ce qu'il a mangé (14 jours)")}</p>
                    {(c.meals ?? []).length === 0 ? <p className="text-sm text-muted">{t("Aucun repas servi récemment.")}</p> : (
                      <ul className="space-y-1.5">
                        {c.meals!.map((m, k) => (
                          <li key={k} className="flex items-center justify-between gap-2 text-sm">
                            <span className="min-w-0 flex-1 truncate font-bold">{m.dish}</span>
                            {m.stars != null && <span className="flex items-center gap-0.5 text-xs font-bold"><Star className="size-3 fill-warn text-warn" />{m.stars}</span>}
                            <span className="shrink-0 text-xs text-muted">{dateTime(m.at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
              <button onClick={() => unlink(c.link_id)} className="w-full border-t border-line py-2.5 text-xs font-bold text-muted">{t("Retirer ce lien")}</button>
            </section>
          );
        })}

        {/* Parent : recevoir les alertes (solde bas, plat signalé) sur WhatsApp et en notification */}
        {o && o.children.length > 0 && (
          <section className="rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
            <p className="font-bold">{t("Recevoir les alertes")}</p>
            <p className="mt-0.5 text-sm text-muted">{t("Solde bas, plat signalé commandé : vous êtes prévenu sur WhatsApp et par notification.")}</p>
            <div className="mt-3 space-y-3"><WhatsAppLink /><PushToggle /></div>
          </section>
        )}

        {/* Côté enfant : parents liés */}
        {o && o.parents.some((p) => p.status === "active") && (
          <section className="rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
            <p className="font-bold">{t("Mes parents liés")}</p>
            <ul className="mt-2 space-y-2">
              {o.parents.filter((p) => p.status === "active").map((p) => (
                <li key={p.link_id} className="flex items-center justify-between text-sm">
                  <span className="font-bold">{p.name}</span>
                  <button onClick={() => unlink(p.link_id)} className="text-xs font-bold text-err">{t("Retirer")}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <Sheet open={!!dietFor} onClose={() => setDietFor(null)} title={en ? `${dietFor?.name.split(" ")[0] ?? ""}’s allergies` : `Allergies de ${dietFor?.name.split(" ")[0] ?? ""}`}>
        <p className="-mt-1 mb-3 text-sm text-muted">{t("Les allergies que vous indiquez ici, votre enfant ne peut pas les retirer. Les plats concernés sont signalés partout, et vous êtes prévenu s'il en commande un.")}</p>
        <div className="flex flex-wrap gap-2">
          {ALLERGIES.map((a) => {
            const on = pAll.includes(a);
            return (
              <button key={a} onClick={() => setPAll((l) => (on ? l.filter((x) => x !== a) : [...l, a]))}
                className={clsx("rounded-full px-3 py-1.5 text-sm font-bold capitalize", on ? "bg-err text-white" : childAll.includes(a) ? "bg-warn-soft" : "bg-canvas")}>
                {on ? "🔒 " : childAll.includes(a) ? "⚠️ " : ""}{allergenLabel(a, en ? "en" : "fr")}
              </button>
            );
          })}
        </div>
        {childAll.some((a) => !pAll.includes(a)) && <p className="mt-2 text-xs text-muted">{t("⚠️ = déclarée par votre enfant (ou l'autre parent) : vous ne pouvez pas la retirer.")}</p>}
        {pAll.length > 0 && (
          <div className="mt-4 rounded-2xl bg-err-soft p-3">
            <p className="text-sm font-extrabold text-err">{t("Lesquelles sont graves ?")}</p>
            <p className="text-xs font-semibold text-ink-2">{t("Grave : impossible de commander un plat qui la contient (même en traces), et l'agent est alerté au comptoir.")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pAll.map((a) => {
                const on = pSev.includes(a);
                return <button key={a} onClick={() => setPSev((l) => (on ? l.filter((x) => x !== a) : [...l, a]))}
                  className={clsx("rounded-full px-3 py-1.5 text-sm font-bold capitalize", on ? "bg-err text-white" : "bg-card")}>{on ? "⛔ " : ""}{allergenLabel(a, en ? "en" : "fr")}</button>;
              })}
            </div>
          </div>
        )}
        <Button block className="mt-4" loading={busy || !dietReady} disabled={!dietReady} onClick={saveDiet}>{t("Enregistrer")}</Button>
      </Sheet>

      <Sheet open={!!recharge} onClose={() => setRecharge(null)} title={`${t("Recharger")} ${recharge?.name.split(" ")[0] ?? ""}`}>
        <p className="-mt-1 mb-3 text-sm text-muted">{t("Paiement Mobile Money (Wave, Orange Money, MTN, Moov, Djamo) sécurisé par Jèko.")}</p>
        <div className="grid grid-cols-2 gap-2">
          {AMOUNTS.map((a) => (
            <button key={a} onClick={() => setAmount(a)} className={clsx("h-14 rounded-2xl text-lg font-extrabold", a === amount ? "bg-ink text-lime" : "bg-canvas")}>{fcfa(a)}</button>
          ))}
        </div>
        <Button block className="mt-4" loading={busy} onClick={doRecharge}>{t("Payer")} {fcfa(amount)}</Button>
      </Sheet>
    </main>
  );
}
