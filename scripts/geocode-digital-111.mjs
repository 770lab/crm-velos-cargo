import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const id = "cmoa7mau001iab2g2laz7nezw";
const ref = db.collection("clients").doc(id);
const snap = await ref.get();
const o = snap.data();
// Normalise PARIS 01..20 → PARIS pour api-adresse
const villeNorm = String(o.ville || "").replace(/^PARIS\s+\d+$/i, "PARIS");
const q = [o.adresse, o.codePostal, villeNorm].filter(Boolean).join(" ");
console.log(`Geocoding: ${q}`);

const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`);
const data = await res.json();
if (!data.features || data.features.length === 0) {
  console.log("Pas trouvé");
  process.exit(1);
}
const [lng, lat] = data.features[0].geometry.coordinates;
await ref.update({ latitude: lat, longitude: lng });
console.log(`✅ ${o.entreprise} géocodé : ${lat}, ${lng}`);
