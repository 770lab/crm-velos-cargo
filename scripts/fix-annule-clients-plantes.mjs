// Yoann 2026-05-03 — annule les clients qui ont "planté" :
// - Vélos affiliés (FNUCI posé) mais jamais livrés
// - Livraisons en cours (planifiee/en_cours) → statut=annulee
//
// Liste validée avec Yoann (3 visibles screenshot + 3 autres du diag) :
//   - CHEN LEO
//   - BATISOLE CONSTRUCTION
//   - ORGANISATION CARREE
//   - NEW WAVE ACADEMY
//   - AGENCE MARCEAU IMMOBILIER
//   - MINE COMPAGNIE
//
// Idempotent. Mode dry-run par défaut.
//   node scripts/fix-annule-clients-plantes.mjs           # DRY-RUN
//   node scripts/fix-annule-clients-plantes.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const CLIENTS_PLANTES = [
  "cmoa7maty01hqb2g2laqluwu4", // CHEN LEO
  "cmoa7masv01frb2g27co6q56o", // BATISOLE CONSTRUCTION
  "cmoa7mat501g9b2g2bw6uwk04", // ORGANISATION CARREE
  "cmoa7mar90170b2g2pb82ij8r", // NEW WAVE ACADEMY
  "cmoa7mb4n03xzb2g23autcngy", // AGENCE MARCEAU IMMOBILIER
  "cmoa7matb01ghb2g2f5ds46xt", // MINE COMPAGNIE
];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} annulation clients plantés ===\n`);

let totalVelos = 0;
let totalLivraisons = 0;

for (const cid of CLIENTS_PLANTES) {
  const cDoc = await db.collection("clients").doc(cid).get();
  if (!cDoc.exists) {
    console.log(`  ⚠ ${cid} introuvable`);
    continue;
  }
  const c = cDoc.data();
  console.log(`\n--- ${c.entreprise} (${c.ville}) [${cid}] ---`);

  // 1. Vélos affiliés non livrés
  const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
  let velosAnnules = 0;
  for (const vd of vSnap.docs) {
    const v = vd.data();
    if (v.annule) continue;
    if (v.dateLivraisonScan) continue; // déjà livré → on touche pas
    if (!v.fnuci) continue; // pas affilié, rien à faire
    console.log(`  vélo ${v.fnuci} (${vd.id}) à annuler`);
    if (APPLY) {
      await vd.ref.update({
        annule: true,
        annuleAt: admin.firestore.FieldValue.serverTimestamp(),
        annuleReason: "Client planté — Yoann 2026-05-03",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    velosAnnules++;
  }
  totalVelos += velosAnnules;

  // 2. Livraisons en cours
  const lvSnap = await db.collection("livraisons").where("clientId", "==", cid).get();
  let livAnnulees = 0;
  for (const ld of lvSnap.docs) {
    const l = ld.data();
    const st = String(l.statut || "").toLowerCase();
    if (st !== "planifiee" && st !== "en_cours") continue;
    console.log(`  livraison ${ld.id} (statut=${l.statut}) → annulee`);
    if (APPLY) {
      await ld.ref.update({
        statut: "annulee",
        annuleAt: admin.firestore.FieldValue.serverTimestamp(),
        annuleReason: "Client planté — Yoann 2026-05-03",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    livAnnulees++;
  }
  totalLivraisons += livAnnulees;

  // 3. Marque le client lui-même comme annulé pour qu il n apparaisse plus
  if (APPLY) {
    await cDoc.ref.update({
      statut: "annulee",
      annulee: true,
      annuleeAt: admin.firestore.FieldValue.serverTimestamp(),
      raisonAnnulation: "Client planté — Yoann 2026-05-03",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  ✓ client marqué annulé`);
  }

  console.log(`  Total : ${velosAnnules} vélos + ${livAnnulees} livraisons annulés`);
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${totalVelos} vélos · ${totalLivraisons} livraisons annulés sur ${CLIENTS_PLANTES.length} clients`);
process.exit(0);
