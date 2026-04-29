import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const auth = admin.auth();

const eqSnap = await db.collection("equipe").get();
console.log("=== Docs équipe Nordine ===");
const nordines = eqSnap.docs.filter((d) => String(d.data().nom||"").toLowerCase().includes("nordine"));
for (const d of nordines) {
  const o = d.data();
  console.log(`\n  doc id=${d.id} nom="${o.nom}" role=${o.role} actif=${o.actif} email=${o.email||"-"}`);
  try {
    const u = await auth.getUser(d.id);
    console.log(`    ✓ Auth uid match : email=${u.email} displayName=${u.displayName} disabled=${u.disabled}`);
  } catch (e) {
    console.log(`    ❌ Pas d'user Auth pour cet uid (${e.code})`);
  }
}
