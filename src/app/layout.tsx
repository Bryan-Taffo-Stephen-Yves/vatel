import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { RegisterSW } from "@/components/register-sw";

export const metadata: Metadata = {
  title: { default: "Vatel", template: "%s · Vatel" },
  description: "Votre cantine dans la poche : rechargez, réservez, scannez.",
  applicationName: "Vatel",
  appleWebApp: { capable: true, title: "Vatel", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#F6F7F9",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Lire les en-têtes rend chaque page à la demande : Next.js y ajoute alors le jeton CSP de la visite (middleware)
  await headers();
  return (
    <html lang="fr">
      <body className="min-h-dvh">
        <ToastProvider>{children}</ToastProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
