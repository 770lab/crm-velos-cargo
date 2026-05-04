// Diag rapide HALLE MARKET livraison du 30/04
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "HALLE MARKET").get();
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`Client : nbVelosCommandes=${c.nbVelosCommandes}, livres=${c.stats?.livres || 0}`);
const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  console.log(`  liv ${ld.id.slice(0, 8)}…  statut=${l.statut}  nbVelos=${l.nbVelos}  date=${l.datePrevue}  tournee=${(l.tourneeId || "").slice(0, 8)}`);
}
process.exit(0);
