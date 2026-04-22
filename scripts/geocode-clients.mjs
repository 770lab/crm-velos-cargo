import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "prisma", "dev.db");
const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

async function geocode(adresse, codePostal, ville) {
  const q = [adresse, codePostal, ville].filter(Boolean).join(" ");
  if (!q.trim()) return null;

  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.features?.length > 0) {
      const [lng, lat] = data.features[0].geometry.coordinates;
      return { latitude: lat, longitude: lng };
    }
  } catch {
    // fallback: try with just postal code + city
    try {
      const fallback = [codePostal, ville].filter(Boolean).join(" ");
      const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(fallback)}&limit=1`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.features?.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates;
        return { latitude: lat, longitude: lng };
      }
    } catch {}
  }
  return null;
}

const clients = await prisma.client.findMany({
  where: { latitude: null },
  select: { id: true, adresse: true, codePostal: true, ville: true, entreprise: true },
});

console.log(`${clients.length} clients à géocoder...`);

let success = 0;
let failed = 0;

for (let i = 0; i < clients.length; i++) {
  const c = clients[i];
  const coords = await geocode(c.adresse, c.codePostal, c.ville);

  if (coords) {
    await prisma.client.update({
      where: { id: c.id },
      data: coords,
    });
    success++;
  } else {
    console.log(`  Échec: ${c.entreprise} (${c.adresse}, ${c.codePostal} ${c.ville})`);
    failed++;
  }

  if ((i + 1) % 50 === 0) {
    console.log(`  ${i + 1}/${clients.length} traités...`);
  }

  // Rate limiting: 50 req/s max for the API
  if ((i + 1) % 40 === 0) await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\nGéocodage terminé: ${success} succès, ${failed} échecs`);
await prisma.$disconnect();
