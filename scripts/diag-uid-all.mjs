import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const list = await admin.auth().listUsers(200);
const eqSnap = await admin.firestore().collection("equipe").get();
const eqIds = new Set(eqSnap.docs.map(d => d.id));
console.log("=== Auth users sans doc equipe (rules vont planter) ===");
for (const u of list.users) {
  if (!eqIds.has(u.uid)) {
    console.log(`  uid=${u.uid} email=${u.email} disabled=${u.disabled}`);
  }
}
process.exit(0);
