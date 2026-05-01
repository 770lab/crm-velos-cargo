// Diag des livraisons fantômes du 28 avril 2026 (tournée 818b8963).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const TARGET_TID = "818b8963";

const livSnap = await db.collection("livraisons").get();
console.log("\n=== Livraisons avec tourneeId préfixé 818b8963 ===\n");
const matches = [];
for (const d of livSnap.docs) {
  const l = d.data();
  if (typeof l.tourneeId !== "string" || !l.tourneeId.startsWith(TARGET_TID)) continue;
  let date = "?";
  if (typeof l.datePrevue === "string") date = l.datePrevue.slice(0, 19);
  else if (l.datePrevue?.toDate) date = l.datePrevue.toDate().toISOString().slice(0, 19);
  matches.push({
    id: d.id,
    tourneeId: l.tourneeId,
    datePrevue: date,
    statut: l.statut,
    nbVelos: l.nbVelos,
    clientId: l.clientId,
    client: l.clientSnapshot?.entreprise || "?",
    chauffeurId: l.chauffeurId,
    monteurIds: l.monteurIds,
    chefEquipeIds: l.chefEquipeIds,
    tourneeNumero: l.tourneeNumero,
  });
}
console.log(`${matches.length} livraisons trouvées`);
for (const m of matches) {
  console.log(`\n  ${m.id}`);
  console.log(`    tourneeId    = ${m.tourneeId}`);
  console.log(`    tourneeNumero= ${m.tourneeNumero}`);
  console.log(`    datePrevue   = ${m.datePrevue}`);
  console.log(`    statut       = ${m.statut}`);
  console.log(`    client       = ${m.client} (${m.clientId})`);
  console.log(`    nbVelos      = ${m.nbVelos}`);
  console.log(`    chauffeurId  = ${m.chauffeurId}`);
  console.log(`    chefEquipeIds= ${JSON.stringify(m.chefEquipeIds)}`);
  console.log(`    monteurIds   = ${JSON.stringify(m.monteurIds)}`);
}

// Cherche aussi par datePrevue=2026-04-28
console.log("\n\n=== Toutes livraisons du 28/04/2026 (tous statuts) ===\n");
const start = new Date("2026-04-28T00:00:00Z");
const end = new Date("2026-04-28T23:59:59Z");
const all28 = [];
for (const d of livSnap.docs) {
  const l = d.data();
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt || dt < start || dt > end) continue;
  all28.push({
    id: d.id,
    statut: l.statut,
    client: l.clientSnapshot?.entreprise || "?",
    nbVelos: l.nbVelos,
    tourneeId: l.tourneeId,
    tourneeNumero: l.tourneeNumero,
  });
}
console.log(`${all28.length} livraisons datées 28/04/2026`);
for (const l of all28) {
  console.log(`  ${l.id} | ${l.statut} | ${l.client} | ${l.nbVelos}v | T${l.tourneeNumero}/${l.tourneeId}`);
}

process.exit(0);
