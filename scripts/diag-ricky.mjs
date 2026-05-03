import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

console.log("=== Recherche Ricky dans equipe ===");
const eqSnap = await db.collection("equipe").get();
for (const d of eqSnap.docs) {
  const e = d.data();
  if (String(e.nom || "").toLowerCase().includes("ricky")) {
    console.log(`\nDoc id=${d.id}`);
    for (const k of Object.keys(e)) {
      const v = e[k];
      const sv = v?.toDate ? v.toDate().toISOString() : v;
      console.log(`  ${k} = ${sv}`);
    }
  }
}

console.log("\n=== Auth users avec email ricky ===");
const list = await admin.auth().listUsers(200);
for (const u of list.users) {
  if (String(u.email || "").toLowerCase().includes("ricky")) {
    console.log(`  uid=${u.uid} email=${u.email} disabled=${u.disabled}`);
  }
}
process.exit(0);
