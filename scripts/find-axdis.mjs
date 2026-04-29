import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const eqSnap = await db.collection("equipe").get();
console.log("=== Docs équipe contenant AXDIS ===");
for (const d of eqSnap.docs) {
  const o = d.data();
  if (String(o.nom||"").toUpperCase().includes("AXDIS")) {
    console.log(`  doc id=${d.id} role=${o.role} actif=${o.actif} email=${o.email||"-"}`);
  }
}

// Cherche aussi par email axdis
console.log("\n=== Docs avec email axdis ===");
for (const d of eqSnap.docs) {
  const o = d.data();
  if (String(o.email||"").toLowerCase().includes("axdis")) {
    console.log(`  doc id=${d.id} nom=${o.nom} email=${o.email}`);
  }
}

console.log("\n=== Liste TOUS les docs équipe (id court / nom) ===");
const sorted = [...eqSnap.docs].sort((a,b) => (a.data().nom||"").localeCompare(b.data().nom||""));
for (const d of sorted) {
  const o = d.data();
  console.log(`  ${d.id.slice(0,12).padEnd(12)} · ${o.nom} (${o.role}) ${o.actif === false ? "[INACTIF]" : ""}`);
}
