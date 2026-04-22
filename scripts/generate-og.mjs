import sharp from "sharp";

const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#111827"/>
  <rect x="40" y="40" width="1120" height="550" rx="32" fill="#1f2937"/>

  <!-- Logo vélo cargo -->
  <g transform="translate(460, 120) scale(3)">
    <circle cx="12" cy="30" r="9" stroke="#22c55e" stroke-width="2.5" fill="none"/>
    <circle cx="12" cy="30" r="2" fill="#22c55e"/>
    <circle cx="52" cy="30" r="9" stroke="#22c55e" stroke-width="2.5" fill="none"/>
    <circle cx="52" cy="30" r="2" fill="#22c55e"/>
    <path d="M12 30 L28 14 L42 14 L52 30" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M28 14 L24 30" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    <path d="M42 14 L46 8 L50 10" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M24 12 L32 12" stroke="#22c55e" stroke-width="3" stroke-linecap="round" fill="none"/>
    <rect x="30" y="18" width="18" height="10" rx="2" stroke="#22c55e" stroke-width="2" fill="#22c55e" fill-opacity="0.15"/>
    <rect x="33" y="21" width="5" height="5" rx="1" fill="#22c55e" fill-opacity="0.4"/>
    <rect x="40" y="22" width="4" height="4" rx="1" fill="#22c55e" fill-opacity="0.3"/>
  </g>

  <!-- Titre -->
  <text x="600" y="400" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="white">Vélos Cargo</text>

  <!-- Sous-titre -->
  <text x="600" y="460" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#9ca3af">Artisans Verts Energy</text>

  <!-- Description -->
  <text x="600" y="530" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#6b7280">Gestion des livraisons de vélos cargo</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile("public/og-image.png");

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="192" height="192">
  <rect width="64" height="64" rx="14" fill="#16a34a"/>
  <g transform="translate(2, 12)">
    <circle cx="12" cy="30" r="9" stroke="white" stroke-width="2.5" fill="none"/>
    <circle cx="12" cy="30" r="2" fill="white"/>
    <circle cx="52" cy="30" r="9" stroke="white" stroke-width="2.5" fill="none"/>
    <circle cx="52" cy="30" r="2" fill="white"/>
    <path d="M12 30 L28 14 L42 14 L52 30" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M28 14 L24 30" stroke="white" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    <path d="M42 14 L46 8 L50 10" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M24 12 L32 12" stroke="white" stroke-width="3" stroke-linecap="round" fill="none"/>
    <rect x="30" y="18" width="18" height="10" rx="2" stroke="white" stroke-width="2" fill="white" fill-opacity="0.15"/>
  </g>
</svg>`;

await sharp(Buffer.from(faviconSvg)).resize(192, 192).png().toFile("public/icon-192.png");
await sharp(Buffer.from(faviconSvg)).resize(512, 512).png().toFile("public/icon-512.png");
await sharp(Buffer.from(faviconSvg)).resize(180, 180).png().toFile("public/apple-touch-icon.png");

console.log("Generated: og-image.png, icon-192.png, icon-512.png, apple-touch-icon.png");
