// Yoann 2026-05-03 — diag pointeuse : identifier où Imed/Dali/Hamma/
// Badreddine sont affectés à tort sur les livraisons du 30/04.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const eqSnap = await db.collection("equipe").get();
const nameById = new Map();
const idByName = new Map();
for (const d of eqSnap.docs) {
  const e = d.data();
  nameById.set(d.id, e.nom || d.id);
  idByName.set(String(e.nom || "").toLowerCase(), d.id);
}

const wanted = ["imed", "dali", "hamma", "badreddine"];
const wantedIds = new Set(wanted.map((n) => idByName.get(n)).filter(Boolean));
console.log("IDs traqués :", Array.from(wantedIds).map((id) => `${nameById.get(id)} (${id})`).join(", "));

const livSnap = await db.collection("livraisons").get();
const isoOf = (x) => x?.toDate ? x.toDate().toISOString() : (typeof x === "string" ? x : null);

console.log("\n=== Livraisons du 29/04 et 30/04 avec ces monteurs ===\n");
for (const d of livSnap.docs) {
  const l = d.data();
  const dp = isoOf(l.datePrevue) || "";
  const day = dp.slice(0, 10);
  if (day !== "2026-04-29" && day !== "2026-04-30") continue;
  if (l.statut === "annulee") continue;
  const monteurIds = Array.isArray(l.monteurIds) ? l.monteurIds : [];
  const overlap = monteurIds.filter((id) => wantedIds.has(id));
  if (overlap.length === 0) continue;
  const cliSnap = l.clientId ? await db.collection("clients").doc(l.clientId).get() : null;
  const cli = cliSnap?.exists ? cliSnap.data().entreprise : "?";
  console.log(`  ${day} · ${cli} (liv ${d.id}) · tournée ${l.tourneeId || "?"}`);
  console.log(`    monteurIds (${monteurIds.length}) : ${monteurIds.map((id) => nameById.get(id) || id).join(", ")}`);
  console.log(`    nbVelos=${l.nbVelos} statut=${l.statut}`);
}

process.exit(0);
