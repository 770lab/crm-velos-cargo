// Géocode les entrepôts qui n'ont pas encore lat/lng via OpenStreetMap
// Nominatim (gratuit, sans clé, ~1 req/sec). Suffisant pour ce one-shot.
// Yoann 2026-05-01.
//
//   node scripts/geocode-entrepots.mjs --apply
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} géocodage entrepôts ===\n`);

const snap = await db.collection("entrepots").get();
const todo = [];
for (const d of snap.docs) {
  const data = d.data();
  if (typeof data.lat === "number" && typeof data.lng === "number") {
    console.log(`✓ ${data.nom} déjà géocodé : ${data.lat}, ${data.lng}`);
    continue;
  }
  const adresseFull = `${data.adresse || ""}, ${data.codePostal || ""} ${data.ville || ""}, France`.trim();
  if (!adresseFull || adresseFull.length < 10) {
    console.log(`⚠ ${data.nom} : adresse trop courte, skip`);
    continue;
  }
  todo.push({ id: d.id, nom: data.nom, adresse: adresseFull, ref: d.ref });
}

console.log(`\n${todo.length} entrepôts à géocoder\n`);

// Yoann 2026-05-03 : Nominatim échoue sur des adresses FR avec typos
// (ex "rue Pierre Lescop" au lieu de "Allée Pierre Lescot"). Fallback
// sur l API BAN data.gouv.fr (officielle, gratuite, autocorrige souvent).
async function geocodeBan(adresse) {
  try {
    const r = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`,
    );
    const j = await r.json();
    const f = j?.features?.[0];
    if (!f?.geometry?.coordinates) return null;
    const [lng, lat] = f.geometry.coordinates;
    return { lat, lng, formatted: f.properties?.label || adresse, score: f.properties?.score };
  } catch {
    return null;
  }
}

for (const t of todo) {
  // Nominatim respect : User-Agent obligatoire + 1 req/sec max
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(t.adresse)}&format=json&limit=1&countrycodes=fr`;
  let result = null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "crm-velos-cargo-geocode/1.0 (yoann@artisansverts.energy)" },
    });
    const j = await r.json();
    if (Array.isArray(j) && j.length > 0) {
      result = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name, source: "nominatim" };
    }
  } catch {}
  await sleep(1100); // respect rate limit Nominatim

  // Fallback BAN gouv.fr (autocorrige typos)
  if (!result) {
    const ban = await geocodeBan(t.adresse);
    if (ban && (ban.score ?? 0) > 0.4) {
      result = { ...ban, source: "ban-gouv" };
    }
  }

  if (!result) {
    console.log(`❌ ${t.nom} : pas de résultat — ${t.adresse}`);
    continue;
  }

  console.log(`✓ ${t.nom.padEnd(30)} ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}  [${result.source}] (${result.formatted.slice(0, 80)})`);
  if (APPLY) {
    await t.ref.set(
      {
        lat: result.lat,
        lng: result.lng,
        adresseGeocodee: result.formatted,
        geocodedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}

if (!APPLY) console.log(`\n(dry-run, relance avec --apply pour persister)\n`);
process.exit(0);
