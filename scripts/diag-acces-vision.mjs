import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const cSnap = await db.collection("clients").where("entreprise", ">=", "GROUPE ACCES").where("entreprise", "<=", "GROUPE ACCES￿").get();
for (const c of cSnap.docs) {
  console.log(`Client: ${c.id} | ${c.data().entreprise} | nbCmd=${c.data().nbVelosCommandes} | stats=${JSON.stringify(c.data().stats)}`);
  const vSnap = await db.collection("velos").where("clientId", "==", c.id).get();
  console.log(`  ${vSnap.size} vélos en base :`);
  for (const v of vSnap.docs) {
    const o = v.data();
    console.log(`    ${v.id} | fnuci=${o.fnuci} | annule=${o.annule} | datePrep=${o.datePreparation ? "OK" : "null"} | createdByAffiliation=${o.createdByAffiliation}`);
  }
}
process.exit(0);
