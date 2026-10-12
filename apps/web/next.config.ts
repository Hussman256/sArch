import type { NextConfig } from "next";

const config: NextConfig = {
  // The SDK ships as TypeScript source; compile it with the app.
  transpilePackages: ["@archpad/sdk"],
  reactStrictMode: true,
  // Coin images are whatever link the creator put on chain. They are shown
  // with a plain <img>, so nothing here needs to fetch or resize them.
  images: { unoptimized: true },
  // `next dev` otherwise writes an AGENTS.md into the app whenever it thinks an
  // AI coding tool is running. Keep generated files out of the repository.
  agentRules: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app has buttons that move money. Never let another site put
          // it in a frame and trick someone into clicking them.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Coin pictures and links go to addresses creators chose. Do not
          // tell those sites which page the visitor came from.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
