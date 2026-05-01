// Diag heures travaillées Naomi via velos.preparateurId + datePreparation
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

// Trouver l'ID Naomi (préparateur actif)
const eqSnap = await db.collection("equipe").get();
const naomis = [];
for (const d of eqSnap.docs) {
  const e = d.data();
  if (e.role === "preparateur" && /naomi/i.test(String(e.nom || ""))) {
    naomis.push({ id: d.id, nom: e.nom, actif: e.actif !== false, tauxHoraire: e.tauxHoraire });
  }
}
console.log("\n=== Préparateurs nommés Naomi ===");
for (const n of naomis) console.log(`  ${n.id}  nom="${n.nom}"  actif=${n.actif}  taux=${n.tauxHoraire}`);

// Pour chaque Naomi : query velos avec preparateurId
for (const n of naomis) {
  console.log(`\n=== Vélos préparés par ${n.nom} (${n.id}) ===`);
  const vSnap = await db.collection("velos").where("preparateurId", "==", n.id).get();
  console.log(`Total : ${vSnap.size} vélos`);
  const parJour = new Map();
  for (const d of vSnap.docs) {
    const v = d.data();
    let t = null;
    if (typeof v.datePreparation === "string") t = new Date(v.datePreparation);
    else if (v.datePreparation?.toDate) t = v.datePreparation.toDate();
    if (!t) continue;
    const dayParis = new Date(t.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
    if (!parJour.has(dayParis)) parJour.set(dayParis, []);
    parJour.get(dayParis).push(t);
  }
  for (const [day, times] of [...parJour.entries()].sort()) {
    times.sort((a, b) => a - b);
    const min = times[0];
    const max = times[times.length - 1];
    const dh = (max - min) / 3600000;
    console.log(`  ${day} : ${times.length} prep, ${min.toISOString()} → ${max.toISOString()} = ${dh.toFixed(2)}h`);
  }
}

// Aussi : chercher dans livraisons les preparateurIds incluant Naomi
console.log("\n\n=== Livraisons avec preparateurIds ⊃ Naomi ===");
const livSnap = await db.collection("livraisons").get();
for (const n of naomis) {
  let count = 0;
  const dates = new Set();
  for (const d of livSnap.docs) {
    const l = d.data();
    if (!Array.isArray(l.preparateurIds) || !l.preparateurIds.includes(n.id)) continue;
    if (l.statut === "annulee") continue;
    count++;
    let dt = null;
    if (typeof l.datePrevue === "string") dt = l.datePrevue.slice(0, 10);
    else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate().toISOString().slice(0, 10);
    if (dt) dates.add(dt);
  }
  console.log(`  ${n.nom} : ${count} livraisons, ${dates.size} dates uniques (${[...dates].sort().join(", ")})`);
}

process.exit(0);
