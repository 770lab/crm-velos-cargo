// Diag des deux jours cette semaine (29 et 30 avril 2026).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const DATES = ["2026-04-29", "2026-04-30"];

const livSnap = await db.collection("livraisons").get();
const clientsByDate = new Map();

for (const d of livSnap.docs) {
  const l = d.data();
  if (l.statut === "annulee") continue;
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt) continue;
  const iso = dt.toISOString().slice(0, 10);
  if (!DATES.includes(iso)) continue;

  if (!clientsByDate.has(iso)) clientsByDate.set(iso, new Map());
  const cid = l.clientId;
  if (!cid) continue;
  if (!clientsByDate.get(iso).has(cid)) {
    clientsByDate.get(iso).set(cid, l.clientSnapshot?.entreprise || cid);
  }
}

for (const date of DATES) {
  console.log(`\n=== ${date} ===\n`);
  const clientsMap = clientsByDate.get(date);
  if (!clientsMap) { console.log("(aucune livraison)"); continue; }
  console.log("Client                          | Velos | Prep | Charg | Livr | Mont");
  console.log("-------------------------------+-------+------+-------+------+------");
  for (const [cid, name] of clientsMap.entries()) {
    const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
    const velos = vSnap.docs.map((d) => d.data()).filter((v) => v.annule !== true);
    const tot = velos.length;
    const p = velos.filter((v) => v.datePreparation).length;
    const c = velos.filter((v) => v.dateChargement).length;
    const l = velos.filter((v) => v.dateLivraisonScan).length;
    const m = velos.filter((v) => v.dateMontage).length;
    const ok = (n) => (tot > 0 && n >= tot ? "✓" : "");
    console.log(
      `${name.padEnd(31)}| ${String(tot).padStart(3)}/${String(tot).padStart(3)} | ${String(p).padStart(2)}${ok(p).padEnd(2)} | ${String(c).padStart(3)}${ok(c).padEnd(2)} | ${String(l).padStart(2)}${ok(l).padEnd(2)} | ${String(m).padStart(2)}${ok(m)}`,
    );
  }
}

// Total global stats.livres
let totalGlobal = 0;
const allClients = await db.collection("clients").get();
for (const d of allClients.docs) {
  totalGlobal += d.data()?.stats?.livres ?? 0;
}
console.log(`\n>> Total global stats.livres en base : ${totalGlobal}`);

process.exit(0);
