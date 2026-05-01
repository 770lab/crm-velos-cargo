// Annule 2 des 7 slots créés à 09:14 pour ANADOLU (pour revenir à 28 actifs).
// Critères : clientId == ANADOLU + fnuci == null + datePreparation == null +
// createdAt récent (les 7 viennent d'être créés à 09:14:08 cette nuit).
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "ANADOLU DISTRIBUTION").get();
const clientId = cSnap.docs[0].id;

const vSnap = await db.collection("velos").where("clientId", "==", clientId).get();
// Slots vraiment vides (mes 7 créations) : pas de FNUCI, pas de datePreparation, pas annulés.
const vides = vSnap.docs
  .filter((d) => {
    const v = d.data();
    return !v.fnuci && !v.datePreparation && v.annule !== true;
  })
  .sort((a, b) => {
    const ta = a.data().createdAt?.toDate?.()?.getTime() || 0;
    const tb = b.data().createdAt?.toDate?.()?.getTime() || 0;
    return tb - ta; // plus récents d'abord
  });

console.log(`📊 Slots vides ANADOLU : ${vides.length} (les 7 créés à 09:14)`);

if (vides.length < 2) {
  console.log("Rien à annuler — pas assez de slots vides.");
  process.exit(0);
}

// On annule les 2 plus récents (donc les 2 derniers créés).
const aAnnuler = vides.slice(0, 2);
const batch = db.batch();
for (const d of aAnnuler) {
  batch.update(d.ref, { annule: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log(`  → annule ${d.id}`);
}
await batch.commit();

console.log(`\n✅ 2 slots soft-cancellés (annule=true, conservés en base pour audit).`);
console.log(`   Il reste ${vides.length - 2} slots vides actifs → tu scannes 5 photos.`);
process.exit(0);
