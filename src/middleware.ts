import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config";
import { safeNext } from "@/lib/next-path";
import { homeFor } from "@/lib/roles";

// Accès par espace (la vraie sécurité reste la RLS ; ceci évite d'afficher un écran inutilisable).
const AREA_ROLES: Record<string, string[]> = {
  // Interface élève / parent : réservée aux clients. L'équipe (agent, caisse, chef, admin) a ses propres écrans.
  "/app": ["client"],
  "/scan": ["agent", "admin"],
  "/admin": ["caissier", "chef", "admin"],
  "/courses": ["agent", "caissier", "chef", "admin"],
};


// Politique de sécurité du contenu (CSP) : seuls les scripts de l'appli, porteurs du jeton de la visite (nonce),
// peuvent s'exécuter ; les données ne partent que vers Supabase ; images seulement de l'appli, de Supabase et des
// fonds de carte OpenStreetMap. Le jeton change à chaque visite : un script injecté ne peut pas le deviner.
// 'wasm-unsafe-eval' seulement sur la caméra d'affluence (modèle de détection en WebAssembly).
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
function contentSecurityPolicy(nonce: string, path: string) {
  const dev = process.env.NODE_ENV !== "production";
  const wasm = path.startsWith("/scan/camera") ? " 'wasm-unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${wasm}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://${SUPABASE_HOST} https://tile.openstreetmap.org`,
    "font-src 'self' data:",
    `connect-src 'self' https://${SUPABASE_HOST} wss://${SUPABASE_HOST}${dev ? " ws:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, req.nextUrl.pathname);
  // Next.js lit le jeton dans l'en-tête de la requête et l'ajoute à ses propres scripts
  const next = () => {
    const h = new Headers(req.headers);
    h.set("x-nonce", nonce);
    h.set("Content-Security-Policy", csp);
    const r = NextResponse.next({ request: { headers: h } });
    r.headers.set("Content-Security-Policy", csp);
    return r;
  };
  let res = next();
  const sb = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = next();
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await sb.auth.getUser();
  const path = req.nextUrl.pathname;
  const area = Object.keys(AREA_ROLES).find((a) => path === a || path.startsWith(a + "/"));
  const isAuthPage = path === "/connexion" || path === "/inscription";

  const redirect = (to: string) => {
    const r = NextResponse.redirect(new URL(to, req.url));
    res.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  if (!user) {
    // Lien profond (ex. invitation parent /app/famille?code=…) : on y revient après la connexion
    if (area) return redirect(`/connexion?next=${encodeURIComponent(path + req.nextUrl.search)}`);
    // « / » : page d'accueil publique (présentation de l'appli, bouton « Tester l'app »)
    return res;
  }

  if (area || path === "/" || isAuthPage) {
    const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).single();
    const role = profile?.role as string | undefined;
    if (path === "/" || isAuthPage) return redirect((isAuthPage && safeNext(req.nextUrl.searchParams.get("next"))) || homeFor(role));
    if (area && !AREA_ROLES[area].includes(role ?? "")) return redirect(homeFor(role));

    // Double authentification : exigée pour certains rôles (réglage), ou si le compte l'a activée.
    // La base l'applique aussi : sans « aal2 », ces rôles perdent leurs droits d'équipe.
    if (area && role && role !== "client") {
      const [{ data: aal }, { data: req }] = await Promise.all([
        sb.auth.mfa.getAuthenticatorAssuranceLevel(),
        sb.from("settings").select("value").eq("key", "mfa_required_roles").maybeSingle(),
      ]);
      const required = Array.isArray(req?.value) && (req.value as string[]).includes(role);
      if (aal && aal.currentLevel !== "aal2" && (required || aal.nextLevel === "aal2")) {
        return redirect(`/double-authentification?next=${encodeURIComponent(path)}`);
      }
    }
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/|favicon|icons/|manifest|sw\\.js|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)"],
};
