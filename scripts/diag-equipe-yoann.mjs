import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const eqSnap = await db.collection("equipe").get();
for (const d of eqSnap.docs) {
  const e = d.data();
  if (String(e.nom || "").toLowerCase().includes("yoann") || e.role === "superadmin") {
    console.log(`  ${d.id} : nom=${e.nom} role=${e.role} actif=${e.actif} email=${e.email}`);
  }
}
process.exit(0);
