import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const ld = await db.collection("livraisons").doc("EIg6KVDQAQqYoGt5Zyuy").get();
const o = ld.data();
console.log("Livraison planifiee EIg6KVDQAQqYoGt5Zyuy :");
console.log(`  clientSnapshot.entreprise=${o.clientSnapshot?.entreprise}`);
console.log(`  tourneeId=${o.tourneeId}`);
console.log(`  datePrevue=${o.datePrevue}`);
console.log(`  createdAt=${o.createdAt?.toDate?.()?.toISOString()}`);

if (o.tourneeId) {
  const tSnap = await db.collection("tournees").doc(o.tourneeId).get();
  if (tSnap.exists) {
    console.log(`  tournée: statut=${tSnap.data().statut} datePrevue=${tSnap.data().datePrevue}`);
    const sib = await db.collection("livraisons").where("tourneeId","==",o.tourneeId).get();
    console.log(`  Tournée a ${sib.size} livraisons :`);
    for (const s of sib.docs) console.log(`    ${s.id} ${s.data().statut} ${s.data().clientSnapshot?.entreprise} (${s.data().nbVelos}v)`);
  } else {
    console.log(`  ⚠️  tournée orpheline (doc tournée n'existe plus)`);
  }
}
