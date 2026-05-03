// Yoann 2026-05-03 — annule tous les FNUCI de test BCZ9CANA* affiliés
// pendant la session de test atelier de cette nuit.
//
// Règle :
//  - Vélos createdByAffiliation=true → soft-cancel (créés à la volée pour
//    le test, à jeter)
//  - Vélos préexistants → on retire juste le fnuci + datePreparation +
//    preparateurId (le vélo doit pouvoir être ré-affilié plus tard)
//
//   node scripts/fix-revert-tests-atelier-2026-05-03.mjs           # DRY-RUN
//   node scripts/fix-revert-tests-atelier-2026-05-03.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");
const FieldValue = admin.firestore.FieldValue;

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} revert tests atelier 2026-05-03 ===\n`);

const all = await db.collection("velos").get();
let nbCanceled = 0;
let nbReset = 0;

for (const vd of all.docs) {
  const v = vd.data();
  const fnuci = String(v.fnuci || "");
  if (!fnuci.startsWith("BCZ9CANA")) continue;
  if (v.annule) continue;

  const cDoc = v.clientId ? await db.collection("clients").doc(v.clientId).get() : null;
  const clientNom = cDoc && cDoc.exists ? cDoc.data().entreprise : "?";

  if (v.createdByAffiliation === true) {
    console.log(`  CANCEL ${fnuci} (${vd.id}) → ${clientNom}`);
    if (APPLY) {
      await vd.ref.update({
        annule: true,
        annuleAt: FieldValue.serverTimestamp(),
        annuleReason: "Test atelier Yoann 2026-05-03 — vélo créé à la volée",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    nbCanceled++;
  } else {
    console.log(`  RESET ${fnuci} (${vd.id}) → ${clientNom} (vélo préexistant, on retire juste le FNUCI)`);
    if (APPLY) {
      await vd.ref.update({
        fnuci: null,
        datePreparation: null,
        preparateurId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    nbReset++;
  }
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${nbCanceled} cancel + ${nbReset} reset`);
process.exit(0);
