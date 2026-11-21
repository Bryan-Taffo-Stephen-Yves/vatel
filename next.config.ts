import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Les pages sont rendues à la demande (règle CSP à jeton par visite) : le téléphone garde chaque page visitée
    // ou préchargée quelques minutes, pour que le changement d'onglet reste instantané.
    staleTimes: { dynamic: 180, static: 300 },
  },
};

export default nextConfig;
