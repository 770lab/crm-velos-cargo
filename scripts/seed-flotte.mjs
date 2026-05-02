// Initialise la flotte de Yoann (2 camions, Yoann 2026-05-03) :
//
//   - Petit camion :  44 cartons OU 20 montés, peut entrer dans Paris
//                     et les petites rues
//   - Grand camion :  77 cartons OU 40 montés, POIDS LOURD restrictions
//                     Paris/petites rues
//
// Idempotent : compare par `nom`. Crée les manquants seulement.
//
//   node scripts/seed-flotte.mjs           # DRY-RUN
//   node scripts/seed-flotte.mjs --apply   # crée les manquants
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");

const CAMIONS = [
  {
    nom: "Petit camion",
    type: "petit",
    capaciteCartons: 44,
    capaciteVelosMontes: 20,
    capaciteVelos: 44, // legacy field — utilise la + grosse capacité
    peutEntrerParis: true,
    actif: true,
    notes: "Peut entrer dans Paris et les petites rues. Format urbain.",
  },
  {
    nom: "Grand camion",
    type: "gros",
    capaciteCartons: 77,
    capaciteVelosMontes: 40,
    capaciteVelos: 77,
    peutEntrerParis: false,
    actif: true,
    notes: "POIDS LOURD — restrictions Paris et petites rues. Privilégier zones péri-urbaines.",
  },
];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} seed flotte ===\n`);

const existingSnap = await db.collection("flotte").get();
const existingByNom = new Map();
for (const d of existingSnap.docs) {
  const data = d.data();
  existingByNom.set(String(data.nom || ""), { id: d.id, data });
}

let created = 0;
let updated = 0;
let unchanged = 0;
for (const c of CAMIONS) {
  const exist = existingByNom.get(c.nom);
  if (exist) {
    // Met à jour les champs manquants ou divergents (capaciteCartons,
    // capaciteVelosMontes, peutEntrerParis nouvellement requis).
    const patch = {};
    if (exist.data.capaciteCartons !== c.capaciteCartons) patch.capaciteCartons = c.capaciteCartons;
    if (exist.data.capaciteVelosMontes !== c.capaciteVelosMontes) patch.capaciteVelosMontes = c.capaciteVelosMontes;
    if (exist.data.peutEntrerParis !== c.peutEntrerParis) patch.peutEntrerParis = c.peutEntrerParis;
    if (exist.data.notes !== c.notes && !exist.data.notes) patch.notes = c.notes;
    if (exist.data.actif !== c.actif) patch.actif = c.actif;
    if (Object.keys(patch).length > 0) {
      console.log(`  ⟳ patch ${c.nom} :`, patch);
      if (APPLY) {
        await db.collection("flotte").doc(exist.id).update({
          ...patch,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      updated++;
    } else {
      console.log(`  = ${c.nom} (déjà OK)`);
      unchanged++;
    }
  } else {
    console.log(`  + ${c.nom} (création)`);
    if (APPLY) {
      await db.collection("flotte").add({
        ...c,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    created++;
  }
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${created} créés · ${updated} patchés · ${unchanged} OK`);
process.exit(0);
