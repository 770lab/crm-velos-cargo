// Yoann 2026-05-03 — ROLLBACK : restaure les clients/vélos/livraisons
// que j'ai annulés à tort dans fix-annule-clients-plantes.mjs.
//
// Cible : tout doc avec annuleReason commençant par "Client planté — Yoann 2026-05-03".
// → annule=false, annulee=false, statut remis à "planifiee" pour les livraisons,
//   suppression des champs annuleAt/annuleReason/raisonAnnulation/annuleeAt.
//
//   node scripts/fix-restore-clients-plantes.mjs           # DRY-RUN
//   node scripts/fix-restore-clients-plantes.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const REASON_PREFIX = "Client planté — Yoann 2026-05-03";
const FieldValue = admin.firestore.FieldValue;

const CLIENTS_PLANTES = [
  "cmoa7maty01hqb2g2laqluwu4", // CHEN LEO
  "cmoa7masv01frb2g27co6q56o", // BATISOLE CONSTRUCTION
  "cmoa7mat501g9b2g2bw6uwk04", // ORGANISATION CARREE
  "cmoa7mar90170b2g2pb82ij8r", // NEW WAVE ACADEMY
  "cmoa7mb4n03xzb2g23autcngy", // AGENCE MARCEAU IMMOBILIER
  "cmoa7matb01ghb2g2f5ds46xt", // MINE COMPAGNIE
];

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} ROLLBACK clients plantés ===\n`);

let totalVelos = 0;
let totalLivraisons = 0;
let totalClients = 0;

for (const cid of CLIENTS_PLANTES) {
  const cDoc = await db.collection("clients").doc(cid).get();
  if (!cDoc.exists) {
    console.log(`  ⚠ ${cid} introuvable`);
    continue;
  }
  const c = cDoc.data();
  console.log(`\n--- ${c.entreprise} (${c.ville}) [${cid}] ---`);

  // 1. Vélos : restaure ceux annulés par mon script
  const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
  let velosRestaures = 0;
  for (const vd of vSnap.docs) {
    const v = vd.data();
    if (!v.annule) continue;
    if (!String(v.annuleReason || "").startsWith(REASON_PREFIX)) continue;
    console.log(`  vélo ${v.fnuci} (${vd.id}) → restauré`);
    if (APPLY) {
      await vd.ref.update({
        annule: false,
        annuleAt: FieldValue.delete(),
        annuleReason: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    velosRestaures++;
  }
  totalVelos += velosRestaures;

  // 2. Livraisons : restaure celles annulées par mon script
  const lvSnap = await db.collection("livraisons").where("clientId", "==", cid).get();
  let livRestaurees = 0;
  for (const ld of lvSnap.docs) {
    const l = ld.data();
    if (String(l.statut || "").toLowerCase() !== "annulee") continue;
    if (!String(l.annuleReason || "").startsWith(REASON_PREFIX)) continue;
    console.log(`  livraison ${ld.id} → planifiee`);
    if (APPLY) {
      await ld.ref.update({
        statut: "planifiee",
        annuleAt: FieldValue.delete(),
        annuleReason: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    livRestaurees++;
  }
  totalLivraisons += livRestaurees;

  // 3. Restaure le client lui-même
  if (String(c.raisonAnnulation || "").startsWith(REASON_PREFIX)) {
    console.log(`  ✓ client restauré`);
    if (APPLY) {
      await cDoc.ref.update({
        statut: "actif",
        annulee: false,
        annuleeAt: FieldValue.delete(),
        raisonAnnulation: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    totalClients++;
  }

  console.log(`  Total : ${velosRestaures} vélos + ${livRestaurees} livraisons restaurés`);
}

console.log(
  `\n${APPLY ? "✓" : "(dry-run)"} ${totalClients} clients · ${totalVelos} vélos · ${totalLivraisons} livraisons restaurés`,
);
process.exit(0);
