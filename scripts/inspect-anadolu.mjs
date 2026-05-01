import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "ANADOLU DISTRIBUTION").get();
const clientDoc = cSnap.docs[0];
const c = clientDoc.data();
console.log(`\n=== Client ANADOLU DISTRIBUTION (${clientDoc.id}) ===`);
console.log(`  nbVelosCommandes : ${c.nbVelosCommandes}`);
console.log(`  nbVelosLivres    : ${c.nbVelosLivres ?? 0}`);
console.log(`  stats            : ${JSON.stringify(c.stats || {})}`);
console.log(`  updatedAt        : ${c.updatedAt?.toDate?.()?.toISOString() || "?"}`);

const livSnap = await db.collection("livraisons").where("clientId", "==", clientDoc.id).get();
console.log(`\n=== Livraisons ANADOLU (${livSnap.docs.length}) ===`);
for (const d of livSnap.docs) {
  const l = d.data();
  console.log(`  livId=${d.id}`);
  console.log(`    nbVelos      : ${l.nbVelos}`);
  console.log(`    statut       : ${l.statut}`);
  console.log(`    datePrevue   : ${l.datePrevue}`);
  console.log(`    tourneeId    : ${l.tourneeId}`);
}

const vSnap = await db.collection("velos").where("clientId", "==", clientDoc.id).get();
const actifs = vSnap.docs.filter((d) => d.data().annule !== true);
const annules = vSnap.docs.length - actifs.length;
const avecFnuci = actifs.filter((d) => d.data().fnuci);
const avecPrep = actifs.filter((d) => d.data().datePreparation);
console.log(`\n=== Vélos ANADOLU ===`);
console.log(`  total docs       : ${vSnap.docs.length}`);
console.log(`  non annulés      : ${actifs.length}`);
console.log(`  annulés (annule=true) : ${annules}`);
console.log(`  avec FNUCI       : ${avecFnuci.length}`);
console.log(`  avec datePrep    : ${avecPrep.length}`);

console.log(`\n=== Détail des 7 derniers vélos non annulés (les plus récents) ===`);
const sorted = actifs.sort((a, b) => {
  const ta = a.data().createdAt?.toDate?.()?.getTime() || 0;
  const tb = b.data().createdAt?.toDate?.()?.getTime() || 0;
  return tb - ta;
});
for (const d of sorted.slice(0, 8)) {
  const v = d.data();
  console.log(`  ${d.id} fnuci=${v.fnuci ?? "—"} prep=${v.datePreparation ? "oui" : "non"} created=${v.createdAt?.toDate?.()?.toISOString() || "?"}`);
}
process.exit(0);
