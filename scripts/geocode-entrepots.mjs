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

for (const t of todo) {
  // Nominatim respect : User-Agent obligatoire + 1 req/sec max
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(t.adresse)}&format=json&limit=1&countrycodes=fr`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "crm-velos-cargo-geocode/1.0 (yoann@artisansverts.energy)" },
    });
    const j = await r.json();
    if (!Array.isArray(j) || j.length === 0) {
      console.log(`❌ ${t.nom} : pas de résultat — ${t.adresse}`);
      await sleep(1100);
      continue;
    }
    const lat = parseFloat(j[0].lat);
    const lng = parseFloat(j[0].lon);
    const formatted = j[0].display_name;
    console.log(`✓ ${t.nom.padEnd(30)} ${lat.toFixed(6)}, ${lng.toFixed(6)}  (${formatted.slice(0, 80)})`);
    if (APPLY) {
      await t.ref.set(
        {
          lat,
          lng,
          adresseGeocodee: formatted,
          geocodedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  } catch (e) {
    console.log(`❌ ${t.nom} : exception ${e}`);
  }
  await sleep(1100); // respect rate limit Nominatim
}

if (!APPLY) console.log(`\n(dry-run, relance avec --apply pour persister)\n`);
process.exit(0);
