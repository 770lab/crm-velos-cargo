import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const cs = await db.collection("clients").get();
for (const d of cs.docs) {
  const c = d.data();
  if (String(c.entreprise || "").toUpperCase().includes("ROLZO")) {
    console.log(`\n=== ${c.entreprise} [${d.id}] ===`);
    console.log("nbVelosCommandes:", c.nbVelosCommandes);
    const v = await db.collection("velos").where("clientId", "==", d.id).get();
    console.log(`vélos: ${v.size}`);
    for (const vd of v.docs) {
      const vv = vd.data();
      console.log(`  ${vd.id} fnuci=${vv.fnuci} annule=${vv.annule} datePreparation=${vv.datePreparation && vv.datePreparation.toDate ? vv.datePreparation.toDate().toISOString() : vv.datePreparation} createdAt=${vv.createdAt && vv.createdAt.toDate ? vv.createdAt.toDate().toISOString() : vv.createdAt}`);
    }
  }
}
process.exit(0);
