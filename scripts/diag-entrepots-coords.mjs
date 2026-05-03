import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("entrepots").get();
console.log("\n=== Entrepôts ===\n");
for (const d of snap.docs) {
  const o = d.data();
  console.log(`${(o.nom || "?").padEnd(22)} | role=${(o.role || "?").padEnd(12)} | lat=${o.lat != null ? o.lat : "MANQUE"} | lng=${o.lng != null ? o.lng : "MANQUE"} | adresse="${o.adresse || ""}", ${o.codePostal || ""} ${o.ville || ""} | archive=${!!o.dateArchivage}`);
}
process.exit(0);
