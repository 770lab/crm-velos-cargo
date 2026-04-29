import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const auth = admin.auth();

console.log("=== Audit equipe ↔ Firebase Auth ===\n");
const eqSnap = await db.collection("equipe").get();
const docs = eqSnap.docs.filter((d) => d.data().actif !== false);
console.log(`${docs.length} membres actifs\n`);

let ok = 0, mismatch = 0, missing = 0;
for (const d of docs) {
  const o = d.data();
  try {
    const u = await auth.getUser(d.id);
    const emailMatch = u.email && o.email && u.email.toLowerCase() === String(o.email).toLowerCase();
    const nameMatch = u.displayName && o.nom && u.displayName.toLowerCase().trim() === String(o.nom).toLowerCase().trim();
    if (emailMatch || nameMatch) {
      ok++;
    } else {
      console.log(`⚠️  ${o.nom} (${d.id})`);
      console.log(`   doc:  email=${o.email||"-"} role=${o.role}`);
      console.log(`   auth: email=${u.email} displayName=${u.displayName}`);
      mismatch++;
    }
  } catch (e) {
    console.log(`❌ ${o.nom} (${d.id}) — pas d'user Auth (${e.code})`);
    missing++;
  }
}
console.log(`\n${ok} OK · ${mismatch} mismatch · ${missing} sans Auth`);

// Liste tous les users Auth orphelins (pas de doc équipe avec leur uid)
console.log("\n=== Users Auth orphelins (uid ≠ aucun doc) ===");
const list = await auth.listUsers(200);
const docIds = new Set(docs.map((d) => d.id));
for (const u of list.users) {
  if (!docIds.has(u.uid)) {
    console.log(`  ${u.uid} email=${u.email} displayName=${u.displayName||"-"}`);
  }
}
