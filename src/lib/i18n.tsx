"use client";
// Multi-langue (bonus du guide Vatel) : français par défaut, anglais au choix. Le choix est gardé sur le téléphone.
// t("texte français") renvoie la traduction anglaise si la langue est « en », sinon le texte d'origine.
import { useSyncExternalStore } from "react";
import { EN_A } from "./i18n-en/a";
import { EN_B } from "./i18n-en/b";
import { EN_C } from "./i18n-en/c";
import { EN_D } from "./i18n-en/d";

export type Lang = "fr" | "en";
const KEY = "dabali:lang";
const listeners = new Set<() => void>();

export function getLang(): Lang {
  try { return (localStorage.getItem(KEY) as Lang) === "en" ? "en" : "fr"; } catch { return "fr"; }
}
export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* stockage indisponible */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
const subscribe = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "fr");
}

const EN: Record<string, string> = {
  // Navigation
  "Accueil": "Home", "Menu": "Menu", "Mon QR": "My QR", "Historique": "History", "Profil": "Profile",
  // Accueil
  "Bonjour": "Hello", "Solde disponible": "Available balance", "Identifiant": "ID", "Recharger": "Top up", "Transférer": "Transfer",
  "Acheter": "Buy", "Offrir": "Gift", "Commander à l'avance": "Order ahead", "Ton plat préparé pour l'heure que tu choisis": "Your dish ready at the time you choose",
  "Mes tickets": "My tickets", "Tout voir": "See all", "Affluence": "Crowd level", "Pour toi": "For you",
  "Bonne matinée": "Good morning", "Bon après-midi": "Good afternoon", "Bon appétit": "Enjoy your meal", "Bonne soirée": "Good evening",
  // Menu
  "Au menu": "On the menu", "Seulement ce qui me convient": "Only what suits me", "Selon tes allergies et ton régime": "Based on your allergies and diet",
  "Pour toi :": "For you:", "Ticket": "Ticket",
  // Profil / régime
  "Mes allergies et mon régime": "My allergies and diet",
  "Les plats qui ne te conviennent pas sont signalés dans le menu, à la commande et par Jean.": "Dishes that don't suit you are flagged in the menu, when ordering and by Jean.",
  "Allergies": "Allergies", "Végétarien": "Vegetarian", "Sans porc": "No pork", "Pas pimenté": "Not spicy",
  "Lesquelles sont graves ?": "Which ones are severe?",
  "Allergie grave : impossible de commander un plat qui la contient (même en traces), et l'agent est alerté au comptoir.": "Severe allergy: you can't order a dish containing it (even traces), and the counter staff is alerted.",
  "grave": "severe",
  "Enregistré.": "Saved.",
  "mon enfant": "my child",
  "Pas encore de repas cette semaine": "No meal yet this week",
  "solde bas": "low balance",
  "veut suivre ton compte": "wants to follow your account",
  "Il pourra recharger ton compte, voir tes repas et être prévenu si ton solde baisse.": "They'll be able to top up your account, see your meals and be alerted when your balance is low.",
  "Suivi par": "Followed by",
  "Recharge ton compte et voit tes repas · tu peux retirer le lien": "Tops up your account and sees your meals · you can remove the link",
  "Inviter mon parent": "Invite my parent",
  "Il recharge ton compte et il est prévenu si ton solde baisse.": "They top up your account and get alerted when your balance is low.",
  "Recevoir les alertes": "Get alerts",
  "Solde bas, plat signalé commandé : vous êtes prévenu sur WhatsApp et par notification.": "Low balance, flagged dish ordered: you get a WhatsApp message and a notification.",
  "Ajoutée par ton parent : seul lui peut la retirer.": "Added by your parent: only they can remove it.", "Langue": "Language",
  "Ma famille": "My family", "Parent : recharger et suivre les repas de votre enfant": "Parent: top up and follow your child's meals",
  "Se déconnecter": "Log out", "Changer mon code PIN": "Change my PIN",
  // Famille
  "Suivre le compte de mon enfant": "Follow my child's account",
  "Entrez son code Vatel (dans son profil, ex. DB-2026). Votre enfant accepte dans son appli.": "Enter their Vatel code (in their profile, e.g. DB-2026). Your child accepts in their app.",
  "Ajouter": "Add", "Recharger son compte": "Top up their account", "Ce qu'il a mangé (14 jours)": "What they ate (14 days)",
  "Aucun repas servi récemment.": "No meals served recently.", "Solde bas : pensez à recharger.": "Low balance: please top up.",
  "Retirer ce lien": "Remove this link", "Mes parents liés": "My linked parents", "Accepter": "Accept", "Refuser": "Decline",
  "cette semaine": "this week", "en attente de son accord": "waiting for their approval",
  // Connexion
  "Mangez sans": "Eat without", "attendre": "waiting", "Rechargez, réservez votre plat, présentez votre QR. C'est tout.": "Top up, book your dish, show your QR. That's it.",
  "E-mail": "Email", "Mot de passe": "Password", "Se connecter": "Log in", "Pas encore de compte ?": "No account yet?",
  "Créer un compte": "Create an account", "Comptes de démo": "Demo accounts",
};

// Dictionnaires par groupe de pages (src/lib/i18n-en/*), fusionnés ici
const ALL_EN: Record<string, string> = { ...EN, ...EN_A, ...EN_B, ...EN_C, ...EN_D };

export function translate(fr: string, lang: Lang): string {
  return lang === "en" ? ALL_EN[fr] ?? fr : fr;
}
export function useT() {
  const lang = useLang();
  return (fr: string) => translate(fr, lang);
}

/** Bouton FR / EN */
export function LangSwitch({ className = "" }: { className?: string }) {
  const lang = useLang();
  return (
    <span className={`inline-flex overflow-hidden rounded-full border border-line bg-card text-xs font-extrabold ${className}`}>
      {(["fr", "en"] as Lang[]).map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
          className={lang === l ? "bg-ink px-3 py-1.5 text-lime" : "px-3 py-1.5 text-muted"}>{l.toUpperCase()}</button>
      ))}
    </span>
  );
}
