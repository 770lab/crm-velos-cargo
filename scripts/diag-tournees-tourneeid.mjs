// Liste les tourneeId de toutes les livraisons du 30/04 pour identifier les
// orphelines (tourneeId=null mais tourneeNumero défini).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const start = new Date("2026-04-30T00:00:00Z");
const end = new Date("2026-04-30T23:59:59Z");

const livSnap = await db.collection("livraisons").get();
const byNumDate = new Map();
for (const d of livSnap.docs) {
  const l = d.data();
  if (l.statut === "annulee") continue;
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt || dt < start || dt > end) continue;
  const key = `T${l.tourneeNumero}|${dt.toISOString().slice(0, 10)}`;
  if (!byNumDate.has(key)) byNumDate.set(key, []);
  byNumDate.get(key).push({
    id: d.id,
    name: l.clientSnapshot?.entreprise || l.clientId,
    tourneeId: l.tourneeId || null,
    statut: l.statut,
    nbVelos: l.nbVelos,
  });
}

console.log("\n=== Tournées 30/04 — tourneeId par livraison ===\n");
for (const [key, livs] of byNumDate.entries()) {
  console.log(`${key} (${livs.length} liv)`);
  const tids = new Set(livs.map((l) => l.tourneeId));
  for (const l of livs) {
    console.log(`  ${l.name.padEnd(30)} tourneeId=${l.tourneeId || "(NULL)"}`);
  }
  if (tids.has(null) && tids.size > 1) {
    console.log(`  ⚠ MIX null/non-null sur cette tournée — incohérent`);
  } else if (tids.has(null) && tids.size === 1) {
    console.log(`  ⚠ TOUS null → progression cassée pour cette tournée`);
  }
  console.log();
}

process.exit(0);
