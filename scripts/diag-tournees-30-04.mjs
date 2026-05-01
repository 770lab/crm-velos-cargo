// Diagnostic état des vélos pour les tournées de Jeu 30 avr 2026.
// Ne modifie rien. Liste pour chaque client le nb de vélos par étape.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const TARGET_DATE = "2026-04-30"; // Jeu 30 avril 2026
const start = new Date(`${TARGET_DATE}T00:00:00Z`);
const end = new Date(`${TARGET_DATE}T23:59:59Z`);

function fmtDate(x) {
  if (!x) return "—";
  if (x.toDate) return x.toDate().toISOString().slice(0, 19);
  if (x instanceof Date) return x.toISOString().slice(0, 19);
  return String(x).slice(0, 19);
}

console.log(`\n=== Diag tournées du ${TARGET_DATE} ===\n`);

const livSnap = await db.collection("livraisons").get();
const clientsByTournee = new Map();
const allClients = new Map();

for (const d of livSnap.docs) {
  const data = d.data();
  if (data.statut === "annulee") continue;
  const dp = data.datePrevue;
  let dt = null;
  if (typeof dp === "string") dt = new Date(dp);
  else if (dp?.toDate) dt = dp.toDate();
  if (!dt || dt < start || dt > end) continue;

  const tNum = data.tourneeNumero ?? "?";
  const cid = data.clientId;
  if (!cid) continue;
  const name = data.clientSnapshot?.entreprise || cid;

  if (!clientsByTournee.has(tNum)) clientsByTournee.set(tNum, new Set());
  clientsByTournee.get(tNum).add(cid);
  if (!allClients.has(cid)) {
    allClients.set(cid, {
      name,
      tNum,
      livIds: [],
      nbVelosTotal: 0,
      dejaChargee: false,
    });
  }
  const c = allClients.get(cid);
  c.livIds.push(d.id);
  c.nbVelosTotal += Number(data.nbVelos) || 0;
  if (data.dejaChargee) c.dejaChargee = true;
}

console.log(`${allClients.size} clients trouvés sur ${clientsByTournee.size} tournée(s).\n`);

const summary = [];
for (const [cid, c] of allClients.entries()) {
  const vSnap = await db
    .collection("velos")
    .where("clientId", "==", cid)
    .get();
  const velos = vSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((v) => v.annule !== true);

  const prep = velos.filter((v) => v.datePreparation).length;
  const chrg = velos.filter((v) => v.dateChargement).length;
  const livr = velos.filter((v) => v.dateLivraisonScan).length;
  const mont = velos.filter((v) => v.dateMontage).length;
  const photoCharg = velos.filter((v) => v.photoChargementUrl).length;
  const photoLivr = velos.filter((v) => v.photoVeloUrl || v.photoFnuciUrl).length;

  const veloIds = velos.map((v) => v.id);
  summary.push({
    cid,
    name: c.name,
    tNum: c.tNum,
    nbVelosLiv: c.nbVelosTotal,
    nbVelosCol: velos.length,
    prep,
    chrg,
    livr,
    mont,
    photoCharg,
    photoLivr,
    veloIds,
    dejaChargee: c.dejaChargee,
  });
}

summary.sort((a, b) => String(a.tNum).localeCompare(String(b.tNum)) || a.name.localeCompare(b.name));

console.log("Tournée | Client                          | Velos(liv/col) | Prep | Charg | Livr | Mont | PhCharg | PhLivr | dejaCh");
console.log("--------+---------------------------------+----------------+------+-------+------+------+---------+--------+-------");
for (const s of summary) {
  const flag = (n, total) => (total > 0 && n >= total ? `${n}/${total}✓` : `${n}/${total}`);
  console.log(
    `T${String(s.tNum).padEnd(6)}| ${s.name.padEnd(32).slice(0, 32)}| ${String(s.nbVelosLiv).padStart(3)}/${String(s.nbVelosCol).padStart(3).padEnd(8)}| ${flag(s.prep, s.nbVelosCol).padEnd(5)}| ${flag(s.chrg, s.nbVelosCol).padEnd(6)}| ${flag(s.livr, s.nbVelosCol).padEnd(5)}| ${flag(s.mont, s.nbVelosCol).padEnd(5)}| ${String(s.photoCharg).padStart(3)}/${String(s.nbVelosCol).padStart(3).padEnd(2)} | ${String(s.photoLivr).padStart(3)}/${String(s.nbVelosCol).padStart(3).padEnd(1)} | ${s.dejaChargee ? "OUI" : "non"}`,
  );
}

console.log("\n=== Détails JSON (pour fix script) ===");
console.log(JSON.stringify(summary.map((s) => ({
  cid: s.cid,
  name: s.name,
  tNum: s.tNum,
  nbVelosLiv: s.nbVelosLiv,
  nbVelosCol: s.nbVelosCol,
  needPrep: s.nbVelosCol - s.prep,
  needCharg: s.nbVelosCol - s.chrg,
  needLivr: s.nbVelosCol - s.livr,
  needMont: s.nbVelosCol - s.mont,
})), null, 2));

process.exit(0);
