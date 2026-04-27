import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const CLIENT_ID = "cmoa7maty01hqb2g2laqluwu4";

const snap = await db.collection("velos").where("clientId", "==", CLIENT_ID).get();
console.log(`Vélos CHEN LEO : ${snap.size}`);
for (const d of snap.docs) {
  const v = d.data();
  console.log(`  - ${d.id} fnuci=${v.fnuci} prep=${!!v.datePreparation} charg=${!!v.dateChargement} livr=${!!v.dateLivraisonScan} mont=${!!v.dateMontage}`);
}

const livSnap = await db.collection("livraisons").where("clientId", "==", CLIENT_ID).get();
console.log(`\nLivraisons CHEN LEO : ${livSnap.size}`);
for (const d of livSnap.docs) {
  const l = d.data();
  console.log(`  - ${d.id} tourneeId=${l.tourneeId} statut=${l.statut}`);
}
process.exit(0);
