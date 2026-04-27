/**
 * Trouve TOUS les clients où une étape a été initiée sans aller au bout :
 * datePreparation OU dateChargement OU dateLivraisonScan posé sur ≥1 vélo
 * sans que dateMontage soit posé sur tous → résidu de test.
 *
 * Inclut les vélos `simulated:true` (script simulation) ET les vrais tests
 * humains sur de vrais clients.
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const velos = await db.collection("velos").get();
const livs = await db.collection("livraisons").get();
const livByClient = new Map();
for (const l of livs.docs) {
  const d = l.data();
  if (!livByClient.has(d.clientId)) livByClient.set(d.clientId, []);
  livByClient.get(d.clientId).push(d);
}

const byClient = new Map();
for (const v of velos.docs) {
  const d = v.data();
  if (d.annule) continue;
  const cid = d.clientId;
  if (!cid) continue;
  if (!byClient.has(cid)) byClient.set(cid, []);
  byClient.get(cid).push(d);
}

const cliSnap = await db.collection("clients").get();
const cliMap = new Map();
for (const c of cliSnap.docs) cliMap.set(c.id, c.data().entreprise || "?");

console.log("Clients avec au moins 1 étape initiée :\n");
const rows = [];
for (const [cid, vs] of byClient) {
  const prep = vs.filter((v) => !!v.datePreparation).length;
  const charg = vs.filter((v) => !!v.dateChargement).length;
  const livr = vs.filter((v) => !!v.dateLivraisonScan).length;
  const mont = vs.filter((v) => !!v.dateMontage).length;
  const sim = vs.filter((v) => !!v.simulated).length;
  if (prep + charg + livr + mont === 0) continue;
  rows.push({
    cid,
    nom: cliMap.get(cid) || "?",
    total: vs.length,
    prep, charg, livr, mont, sim,
    livStatut: (livByClient.get(cid) || []).map((l) => l.statut).join(","),
  });
}
rows.sort((a, b) => a.nom.localeCompare(b.nom));
for (const r of rows) {
  const tag = r.sim === r.total ? "[SIM]" : r.sim > 0 ? "[MIX]" : "[REEL]";
  console.log(
    `${tag.padEnd(7)} ${r.nom.padEnd(28)} ${r.total}v · prep ${r.prep} · charg ${r.charg} · livr ${r.livr} · mont ${r.mont} · sim ${r.sim} · liv:${r.livStatut}`,
  );
}
console.log(`\nTotal clients touchés : ${rows.length}`);
console.log(`  · 100% simulés : ${rows.filter((r) => r.sim === r.total).length}`);
console.log(`  · réels (humain): ${rows.filter((r) => r.sim < r.total).length}`);
process.exit(0);
