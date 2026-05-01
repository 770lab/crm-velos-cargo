// Initialise les 4 entrepôts utilisés par Yoann (Yoann 2026-05-01) :
// - AXDIS PRO Le Blanc-Mesnil : entrepôt source (cartons reçus de Tiffany)
// - Nanterre, Lisses, Chelles : entrepôts secondaires (stock vélos montés)
//
// Idempotent : ne réécrit pas un entrepôt existant (compare par `slug`).
//
//   node scripts/seed-entrepots.mjs           # DRY-RUN
//   node scripts/seed-entrepots.mjs --apply   # crée les manquants
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");

const ENTREPOTS = [
  {
    slug: "axdis-pro",
    nom: "AXDIS PRO",
    adresse: "2 Rue des Frères Lumière",
    codePostal: "93150",
    ville: "Le Blanc-Mesnil",
    lat: 48.9545398,
    lng: 2.4557494,
    isPrimary: true,
    role: "fournisseur", // entrepôt source (cartons reçus)
    notes: "Entrepôt source AXDIS — cartons livrés par Tiffany. Origine de toutes les tournées en cartons.",
  },
  {
    slug: "nanterre",
    nom: "Nanterre",
    adresse: "52 rue Pierre Lescop",
    codePostal: "92000",
    ville: "Nanterre",
    isPrimary: false,
    role: "stock", // stock vélos montés
    notes: "Entrepôt stock vélos montés — Yoann.",
  },
  {
    slug: "lisses",
    nom: "Lisses",
    adresse: "10 rue des Malines",
    codePostal: "91090",
    ville: "Lisses",
    isPrimary: false,
    role: "stock",
    notes: "Entrepôt stock vélos montés — Yoann.",
  },
  {
    slug: "chelles",
    nom: "Chelles",
    adresse: "115 bis avenue du Gendarme Castermant",
    codePostal: "77500",
    ville: "Chelles",
    isPrimary: false,
    role: "stock",
    notes: "Entrepôt stock vélos montés — Yoann.",
  },
];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} seed entrepôts ===\n`);

const existing = await db.collection("entrepots").get();
const existingBySlug = new Map();
for (const d of existing.docs) {
  const data = d.data();
  if (data.slug) existingBySlug.set(data.slug, { id: d.id, ...data });
}

let toCreate = 0;
let alreadyOk = 0;
for (const e of ENTREPOTS) {
  if (existingBySlug.has(e.slug)) {
    console.log(`  ✓ ${e.nom} (${e.slug}) déjà présent — id=${existingBySlug.get(e.slug).id}`);
    alreadyOk++;
  } else {
    console.log(`  + ${e.nom} (${e.slug}) à créer`);
    toCreate++;
  }
}

console.log(`\n${toCreate} à créer · ${alreadyOk} déjà OK\n`);

if (!APPLY) {
  console.log("(dry-run, relance avec --apply)\n");
  process.exit(0);
}

if (toCreate === 0) {
  console.log("Rien à créer.\n");
  process.exit(0);
}

console.log(">>> APPLY EN COURS...\n");
const batch = db.batch();
for (const e of ENTREPOTS) {
  if (existingBySlug.has(e.slug)) continue;
  const ref = db.collection("entrepots").doc(); // auto-id
  batch.set(ref, {
    ...e,
    stockCartons: 0,
    stockVelosMontes: 0,
    capaciteMax: null,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`  ✓ ${e.nom} créé (id=${ref.id})`);
}
await batch.commit();
console.log(`\n✓ ${toCreate} entrepôts créés.\n`);
process.exit(0);
