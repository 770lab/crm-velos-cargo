// Fix immediat : livraison HALLE MARKET nbVelos 25 -> 35
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cSnap = await db.collection("clients").where("entreprise", "==", "HALLE MARKET").get();
const cDoc = cSnap.docs[0];
const livSnap = await db.collection("livraisons").where("clientId", "==", cDoc.id).get();
for (const ld of livSnap.docs) {
  const l = ld.data();
  if (l.statut === "annulee") continue;
  if (l.nbVelos === 35) { console.log(`  ${ld.id.slice(0,8)} deja a 35`); continue; }
  console.log(`  patch ${ld.id.slice(0,8)} : nbVelos ${l.nbVelos} -> 35`);
  await ld.ref.update({
    nbVelos: 35,
    nbVelosFixReason: "fix HALLE MARKET cap silencieux a la creation, Yoann 2026-05-04",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
process.exit(0);
