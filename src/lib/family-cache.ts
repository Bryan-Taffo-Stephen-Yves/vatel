"use client";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "@/lib/supabase/client";

/**
 * family_overview avec affichage immédiat : la dernière réponse est gardée sur le téléphone (par compte)
 * et montrée tout de suite, puis remplacée par la réponse fraîche. Sert à l'accueil parent et à « Ma famille ».
 */
export function useFamilyOverview<T>(userId: string | undefined) {
  const key = userId ? `dabali:family:${userId}` : null;
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(async () => {
    const r = await rpc<T>("family_overview");
    if (!r.ok) return;
    setData(r as unknown as T);
    if (key) try { localStorage.setItem(key, JSON.stringify(r)); } catch {}
  }, [key]);
  useEffect(() => {
    if (!key) return;
    try { const c = localStorage.getItem(key); if (c) setData((d) => d ?? (JSON.parse(c) as T)); } catch {}
    load();
  }, [key, load]);
  return { data, load };
}
