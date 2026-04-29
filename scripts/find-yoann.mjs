import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const auth = admin.auth();

const eqSnap = await db.collection("equipe").get();
console.log("=== Tous docs équipe Yoann ===");
for (const d of eqSnap.docs) {
  const o = d.data();
  if (String(o.nom||"").toLowerCase().includes("yoann")) {
    console.log(`  doc id=${d.id} role=${o.role} actif=${o.actif} email=${o.email||"-"}`);
  }
}
console.log("\n=== Users Auth contenant yoann ===");
const list = await auth.listUsers(200);
for (const u of list.users) {
  if ((u.email||"").toLowerCase().includes("yoann") || (u.displayName||"").toLowerCase().includes("yoann")) {
    console.log(`  uid=${u.uid} email=${u.email} displayName=${u.displayName}`);
  }
}
