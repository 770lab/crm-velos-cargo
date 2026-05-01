// Diag pointeuse : pourquoi des gens comptent 3 jours alors qu on a
// travaille 2, et pourquoi des "3", "6", "8" apparaissent.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

console.log("\n=== Toutes les livraisons avec monteurIds (29 avril → 1 mai 2026) ===\n");
const start = new Date("2026-04-28T00:00:00Z");
const end = new Date("2026-05-02T23:59:59Z");

const livSnap = await db.collection("livraisons").get();
const livs = [];
for (const d of livSnap.docs) {
  const l = d.data();
  if (l.statut === "annulee") continue;
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt || dt < start || dt > end) continue;
  livs.push({
    id: d.id,
    date: dt.toISOString().slice(0, 10),
    tourneeId: l.tourneeId || "(null)",
    client: l.clientSnapshot?.entreprise || l.clientId,
    statut: l.statut,
    monteurIds: Array.isArray(l.monteurIds) ? l.monteurIds : [],
    chefIds: Array.isArray(l.chefEquipeIds) ? l.chefEquipeIds : (l.chefEquipeId ? [l.chefEquipeId] : []),
  });
}

// Group by tourneeId+date
const byTourneeDate = new Map();
for (const l of livs) {
  const k = `${l.tourneeId}|${l.date}`;
  if (!byTourneeDate.has(k)) byTourneeDate.set(k, []);
  byTourneeDate.get(k).push(l);
}

console.log(`${byTourneeDate.size} groupes (tournée+date) trouvés\n`);
for (const [key, group] of byTourneeDate.entries()) {
  const allMonteurs = new Set();
  for (const l of group) for (const id of l.monteurIds) allMonteurs.add(id);
  const allChefs = new Set();
  for (const l of group) for (const id of l.chefIds) allChefs.add(id);
  console.log(`${key}  (${group.length} liv, ${[...new Set(group.map(l => l.statut))].join("/")})`);
  console.log(`  ${allMonteurs.size} monteurs : ${[...allMonteurs].join(", ")}`);
  console.log(`  ${allChefs.size} chefs : ${[...allChefs].join(", ")}`);
}

// Recense les doublons d équipe
console.log(`\n\n=== Recensement équipe : doublons potentiels ===\n`);
const eqSnap = await db.collection("equipe").get();
const byNom = new Map();
for (const d of eqSnap.docs) {
  const e = d.data();
  const nom = (e.nom || "").trim();
  if (!byNom.has(nom)) byNom.set(nom, []);
  byNom.get(nom).push({ id: d.id, role: e.role, actif: e.actif !== false });
}
console.log(`${eqSnap.size} membres équipe au total.`);
console.log(`Doublons par nom :\n`);
let dupesFound = 0;
for (const [nom, list] of byNom.entries()) {
  if (list.length > 1) {
    dupesFound++;
    console.log(`  "${nom}" : ${list.length} fiches`);
    for (const m of list) console.log(`    - id=${m.id} role=${m.role} actif=${m.actif}`);
  }
}
if (dupesFound === 0) console.log("  (aucun doublon par nom exact)");

// Recense les noms qui sont juste un chiffre (potentiels orphelins)
console.log(`\n\n=== Membres avec un nom "numérique" (3, 6, 8...) ===\n`);
for (const d of eqSnap.docs) {
  const e = d.data();
  const nom = String(e.nom || "").trim();
  if (/^\d+$/.test(nom)) {
    console.log(`  id=${d.id} nom="${nom}" role=${e.role} actif=${e.actif !== false}`);
  }
}

process.exit(0);
