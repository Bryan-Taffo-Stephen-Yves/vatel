import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { supabaseServer } from "@/lib/supabase/server";
import { homeFor } from "@/lib/roles";
import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  title: "Vatel Cantine · Réservez, payez, mangez",
  description: "La cantine de l'école dans le téléphone : menu de la semaine, plat réservé à l'heure choisie, paiement Mobile Money et QR au comptoir.",
};

/** Accueil : un visiteur voit la présentation de l'appli ; une personne connectée va directement dans son espace. */
export default async function Root() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return <Landing />;
  const { data } = await sb.from("profiles").select("role").eq("id", user.id).single();
  redirect(homeFor(data?.role));
}
