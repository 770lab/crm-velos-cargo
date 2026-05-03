// Yoann 2026-05-03 — vérifie l'état du 29/04 après correction.
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const eqSnap = await db.collection("equipe").get();
const nameById = new Map();
for (const d of eqSnap.docs) nameById.set(d.id, d.data().nom || d.id);

const isoOf = (x) => x?.toDate ? x.toDate().toISOString() : (typeof x === "string" ? x : null);

console.log("\n=== Récap 29/04 et 30/04 après correction ===\n");
const livSnap = await db.collection("livraisons").get();
const byDay = { "2026-04-29": [], "2026-04-30": [] };
for (const d of livSnap.docs) {
  const l = d.data();
  const day = (isoOf(l.datePrevue) || "").slice(0, 10);
  if (!byDay[day]) continue;
  if (l.statut === "annulee") continue;
  byDay[day].push({ id: d.id, ...l });
}
for (const day of Object.keys(byDay)) {
  console.log(`\n--- ${day} (${byDay[day].length} livraisons) ---`);
  const monteurAgg = new Map();
  for (const l of byDay[day]) {
    const cli = await db.collection("clients").doc(l.clientId).get();
    const cliNom = cli.exists ? cli.data().entreprise : "?";
    const monteurs = (l.monteurIds || []).map((id) => nameById.get(id) || id);
    console.log(`  ${cliNom} (${l.nbVelos}v) [${l.statut}] · monteurs : ${monteurs.join(", ") || "—"}`);
    for (const id of (l.monteurIds || [])) {
      const m = monteurAgg.get(id) || { jours: new Set(), velos: 0 };
      m.jours.add(day);
      m.velos += l.statut === "livree" ? Number(l.nbVelos || 0) : 0;
      monteurAgg.set(id, m);
    }
  }
  console.log(`  → Pointeuse pour ce jour :`);
  for (const [id, m] of monteurAgg) {
    console.log(`     ${nameById.get(id)} : ${m.jours.size} jour · ${m.velos} vélos livrés`);
  }
}
process.exit(0);
