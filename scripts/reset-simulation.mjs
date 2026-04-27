/**
 * Reset des données générées par scripts/simulate-flow-tournee.mjs.
 * Détecte tous les vélos et livraisons avec `simulated: true` et les remet
 * à zéro (FNUCI, dates étapes, photos, statut). Re-statise les clients touchés.
 *
 * Usage :
 *   node scripts/reset-simulation.mjs              (dry-run)
 *   node scripts/reset-simulation.mjs --apply
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

const vSnap = await db.collection("velos").where("simulated", "==", true).get();
const lvSnap = await db.collection("livraisons").where("simulated", "==", true).get();

console.log(`Vélos simulés      : ${vSnap.size}`);
console.log(`Livraisons simulées: ${lvSnap.size}`);

if (vSnap.empty && lvSnap.empty) {
  console.log("\nRien à reset.");
  process.exit(0);
}

const clientIds = new Set();
if (APPLY) {
  // Reset vélos par batches de 400 (limite Firestore 500 ops/batch).
  const allVelos = vSnap.docs;
  for (let i = 0; i < allVelos.length; i += 400) {
    const batch = db.batch();
    for (const veloDoc of allVelos.slice(i, i + 400)) {
      const v = veloDoc.data();
      if (v.clientId) clientIds.add(v.clientId);
      batch.update(veloDoc.ref, {
        fnuci: null,
        datePreparation: null,
        dateChargement: null,
        dateLivraisonScan: null,
        dateMontage: null,
        monteParId: null,
        urlPhotoMontageEtiquette: null,
        urlPhotoMontageQrVelo: null,
        photoMontageUrl: null,
        simulated: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  const lvBatch = db.batch();
  for (const lvDoc of lvSnap.docs) {
    const l = lvDoc.data();
    if (l.clientId) clientIds.add(l.clientId);
    lvBatch.update(lvDoc.ref, {
      statut: "planifiee",
      dateEffective: null,
      urlBlSigne: null,
      // On ne supprime pas blNumero (séquentiel global) pour ne pas casser la
      // numérotation. Si tu veux le retirer, fais-le à la main pour les BL-SIM*.
      simulated: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await lvBatch.commit();

  // Recalcul stats des clients touchés
  console.log(`\n🔄 Recalcul stats des ${clientIds.size} clients touchés…`);
  for (const cid of clientIds) {
    const vs = await db.collection("velos").where("clientId", "==", cid).get();
    const velos = vs.docs.filter((d) => !d.data().annule);
    const lv = await db.collection("livraisons").where("clientId", "==", cid).get();
    const lvs = lv.docs.map((d) => d.data());
    await db.collection("clients").doc(cid).update({
      stats: {
        totalVelos: velos.length,
        montes: velos.filter((v) => !!v.data().dateMontage).length,
        livres: velos.filter((v) => !!v.data().dateLivraisonScan).length,
        totalLivraisonsLivrees: lvs.filter((l) => l.statut === "livree").length,
        blSignes: lvs.filter((l) => !!l.urlBlSigne).length,
        facturables: 0,
        planifies: lvs.filter((l) => l.statut === "planifiee").length,
        certificats: velos.filter((v) => !!v.data().fnuci).length,
        factures: 0,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log("✅ Reset terminé.");
} else {
  console.log("\n→ Relance avec --apply pour exécuter.");
}

process.exit(0);
