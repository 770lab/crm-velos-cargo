import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("clients").where("entreprise", ">=", "ANADOLU").where("entreprise", "<=", "ANADOLU￿").get();
for (const d of snap.docs) {
  const o = d.data();
  console.log(`${d.id} | ${o.entreprise} | nbVelos=${o.nbVelosCommandes} | stats=${JSON.stringify(o.stats)} | statut=${o.statut} | annulee=${o.annulee}`);
}
process.exit(0);
