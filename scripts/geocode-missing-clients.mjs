/**
 * Géocode les clients sans lat/lng. Idempotent. Skip ceux sans adresse.
 * Usage:
 *   node scripts/geocode-missing-clients.mjs              (dry-run)
 *   node scripts/geocode-missing-clients.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

const cSnap = await db.collection("clients").get();
const aGeocoder = [];
for (const d of cSnap.docs) {
  const o = d.data();
  if (typeof o.latitude === "number" && typeof o.longitude === "number") continue;
  if (o.statut === "annulee") continue;
  const adresse = String(o.adresse || "").trim();
  if (!adresse) continue;
  const villeNorm = String(o.ville || "").replace(/^PARIS\s+\d+$/i, "PARIS");
  const q = [adresse, o.codePostal, villeNorm].filter(Boolean).join(" ");
  aGeocoder.push({ id: d.id, entreprise: o.entreprise || "", q });
}

console.log(`Clients à géocoder : ${aGeocoder.length}\n`);
if (aGeocoder.length === 0) process.exit(0);

let ok = 0;
let ko = 0;
for (const c of aGeocoder) {
  try {
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(c.q)}&limit=1`);
    const data = await res.json();
    if (!data.features || data.features.length === 0) {
      console.log(`  ❌ ${c.entreprise} (${c.q}) — pas trouvé`);
      ko++;
      continue;
    }
    const [lng, lat] = data.features[0].geometry.coordinates;
    if (APPLY) {
      await db.collection("clients").doc(c.id).update({ latitude: lat, longitude: lng });
    }
    console.log(`  ✅ ${c.entreprise} → ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    ok++;
  } catch (e) {
    console.log(`  ⚠️ ${c.entreprise} — erreur: ${e.message}`);
    ko++;
  }
  // Politesse api-adresse
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`\n${ok} OK · ${ko} KO`);
if (!APPLY) console.log("(dry-run — relance avec --apply)");
