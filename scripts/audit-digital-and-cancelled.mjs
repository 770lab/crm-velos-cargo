import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

console.log("=== Recherche DIGITAL ===");
const cSnap = await db.collection("clients").get();
for (const d of cSnap.docs) {
  const o = d.data();
  if (String(o.entreprise || "").toUpperCase().includes("DIGITAL")) {
    console.log(`${d.id} · ${o.entreprise}`);
    console.log(`  ville=${o.ville} · CP=${o.codePostal}`);
    console.log(`  lat=${o.latitude} · lng=${o.longitude}`);
    console.log(`  statut=${o.statut} · raisonAnnulation=${o.raisonAnnulation}`);
    console.log(`  nbVelosCommandes=${o.nbVelosCommandes}`);
  }
}

console.log("\n=== Tous les clients statut=annulee ===");
let nb = 0;
for (const d of cSnap.docs) {
  const o = d.data();
  if (o.statut === "annulee") {
    nb++;
    console.log(`${d.id} · ${o.entreprise} · raison=${o.raisonAnnulation || "(sans raison)"}`);
  }
}
console.log(`Total : ${nb}`);
