// Corrige les FNUCI hallucinés Gemini à la prep tournée 38 (30-04).
// Source de vérité : fichier Excel manuel de Yoann (image 66).
// Skip les 3 lignes problématiques (format invalide ou croisé).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

// [old fnuci en base, new fnuci correct]
const FIXES = [
  // BATISOLE CONSTRUCTION
  ["BC389NJ4B9", "BC3B9NJ4B9"],
  // GPCONSULTING
  ["BC66ABTFZ9", "BC56ABTFZ9"],
  ["BCSEBXSBAE", "BC5E8XS8AE"],
  ["BC835HH678", "BC835HH676"],
  ["BCB9BCZ8CA", "BC898CZ8CA"],
  ["BCZ86AXF5F", "BCZB6AXF5F"],
  ["BC547T2C3E", "BC547TZC3E"],
  ["BC766HSZ0C", "BC766SH5ZC"],
  ["BC489AT9H3", "BC469AT9H3"],
  ["BC29CZZ982", "BC29CZZ9B2"],
  ["BCE94PHEBC", "BCE94PHE8C"],
  ["BCF99B0E43", "BCF99BDE43"],
  ["BC364CF7SA", "BC364CF75A"],
  ["BCABSHN006", "BCA85HN9D6"],
];

// Skipped (à retravailler par Yoann manuellement) :
// - BCCF5JXB8B → BCZ5ZNFF6C6 (11 chars invalide)
// - BCZ5ZNF6C8 → BCCF5JX8B8 (croisé avec ligne ci-dessus, ambigu)
// - BCB4MPXA4A → BCB4PX4A4 (9 chars invalide)
const FORMAT_RE = /^BC[A-Z0-9]{8}$/;

console.log(`\n=== Correction FNUCI tournée 38 (${FIXES.length} fixes) ===\n`);

let okCount = 0;
let skipCount = 0;
const log = [];

for (const [oldFn, newFn] of FIXES) {
  if (!FORMAT_RE.test(newFn)) {
    console.log(`❌ skip ${oldFn} → ${newFn} : format invalide`);
    skipCount++;
    continue;
  }

  // 1. Vérifier que le newFn n'existe pas déjà en base (sinon doublon)
  const existSnap = await db.collection("velos").where("fnuci", "==", newFn).get();
  if (!existSnap.empty) {
    console.log(`❌ skip ${oldFn} → ${newFn} : DOUBLON, ${newFn} existe déjà`);
    skipCount++;
    continue;
  }

  // 2. Trouver le vélo avec l'ancien FNUCI
  const oldSnap = await db.collection("velos").where("fnuci", "==", oldFn).get();
  if (oldSnap.empty) {
    console.log(`❌ skip ${oldFn} → ${newFn} : ancien FNUCI introuvable en base`);
    skipCount++;
    continue;
  }
  if (oldSnap.size > 1) {
    console.log(`❌ skip ${oldFn} → ${newFn} : ${oldSnap.size} vélos avec ce FNUCI (incident)`);
    skipCount++;
    continue;
  }

  // 3. Update + log
  const veloDoc = oldSnap.docs[0];
  await veloDoc.ref.update({
    fnuci: newFn,
    fnuciPrevious: oldFn, // log de l'ancien pour traçabilité
    fnuciFixedAt: admin.firestore.FieldValue.serverTimestamp(),
    fnuciFixedReason: "yoann manual correction tournee 38 - gemini hallucination",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`✓ ${oldFn} → ${newFn}  (veloId=${veloDoc.id})`);
  okCount++;
  log.push({ veloId: veloDoc.id, oldFn, newFn });
}

console.log(`\n${okCount} corrigés · ${skipCount} skippés`);
console.log("\nRéimprime le CSV depuis l'app pour avoir les bons FNUCI à envoyer à Tiffany.");

process.exit(0);
