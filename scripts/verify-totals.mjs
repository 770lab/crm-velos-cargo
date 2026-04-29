import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const cSnap = await db.collection("clients").get();
let sumNbCmd = 0, sumTotalSt = 0, sumLivres = 0;
for (const d of cSnap.docs) {
  const o = d.data();
  if (o.statut === "annulee") continue;
  sumNbCmd += Number(o.nbVelosCommandes) || 0;
  sumTotalSt += Number(o.stats?.totalVelos) || 0;
  sumLivres += Number(o.stats?.livres) || 0;
}
console.log(`SUM(nbVelosCommandes) = ${sumNbCmd}  ← devis cumulé`);
console.log(`SUM(stats.totalVelos) = ${sumTotalSt}  ← affiché « Vélos total » dashboard`);
console.log(`SUM(stats.livres)     = ${sumLivres}  ← affiché « Vélos livrés »`);
