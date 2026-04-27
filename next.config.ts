import type { NextConfig } from "next";

// Le repo est aussi déployé sur GitHub Pages sous /crm-velos-cargo.
// Sur Firebase Hosting (et en dev local Firebase) on sert à la racine,
// donc on conditionne le basePath via DEPLOY_TARGET.
const deployTarget = process.env.DEPLOY_TARGET || "github";
const isGithubPages = deployTarget === "github";
const basePath = isGithubPages ? "/crm-velos-cargo" : "";

// Expose le basePath au runtime client pour withBase() dans src/lib/base-path.ts
process.env.NEXT_PUBLIC_BASE_PATH = basePath;

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
