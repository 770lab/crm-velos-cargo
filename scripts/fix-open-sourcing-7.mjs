// Fix immediat OPEN SOURCING : livraison nbVelos -> 7 (= nbVelosCommandes)
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "OPEN SOURCING").get();
const cDoc = cSnap.docs[0];
const c = cDoc.data();
console.log(`Client : nbVelosCommandes=${c.nbVelosCommandes}, livres=${c.stats?.livres || 0}`);
const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  if (l.statut === "annulee") continue;
  const target = (c.nbVelosCommandes || 0) - (c.stats?.livres || 0);
  if (l.nbVelos === target) { console.log(`  ${ld.id.slice(0,8)} deja a ${target}`); continue; }
  console.log(`  patch ${ld.id.slice(0,8)} : nbVelos ${l.nbVelos} -> ${target}`);
  await ld.ref.update({
    nbVelos: target,
    nbVelosFixReason: `fix OPEN SOURCING cap silencieux (${l.nbVelos} -> ${target}), Yoann 2026-05-04`,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
process.exit(0);
