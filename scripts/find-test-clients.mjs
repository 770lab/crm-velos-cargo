/**
 * Trouve les clients avec des vélos préparés (et autres étapes) sur les
 * dernières 48h, pour identifier les tests laissés en l'état.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sa = JSON.parse(
  readFileSync(join(__dirname, "migration-data", "service-account.json"), "utf8"),
);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const since = new Date(Date.now() - 48 * 3600 * 1000);

const snap = await db
  .collection("velos")
  .where("datePreparation", ">=", admin.firestore.Timestamp.fromDate(since))
  .get();

console.log(`Vélos préparés depuis ${since.toLocaleString("fr-FR")}: ${snap.size}\n`);

const byClient = new Map();
for (const d of snap.docs) {
  const v = d.data();
  const cid = v.clientId || "(aucun)";
  if (!byClient.has(cid)) byClient.set(cid, []);
  byClient.get(cid).push({
    veloId: d.id,
    fnuci: v.fnuci,
    datePreparation: v.datePreparation?.toDate?.()?.toLocaleString("fr-FR"),
    dateChargement: v.dateChargement?.toDate?.()?.toLocaleString("fr-FR") || "—",
    dateLivraisonScan: v.dateLivraisonScan?.toDate?.()?.toLocaleString("fr-FR") || "—",
    dateMontage: v.dateMontage?.toDate?.()?.toLocaleString("fr-FR") || "—",
  });
}

for (const [cid, list] of byClient) {
  let nom = "(client supprimé ou inconnu)";
  if (cid !== "(aucun)") {
    const c = await db.collection("clients").doc(cid).get();
    if (c.exists) nom = c.data().nom || nom;
  }
  console.log(`\n📦 ${nom}  [${cid}]  — ${list.length} vélo(s)`);
  for (const v of list) {
    console.log(
      `   ${v.fnuci || "(no fnuci)"}  prep=${v.datePreparation}  charg=${v.dateChargement}  livr=${v.dateLivraisonScan}  mont=${v.dateMontage}`,
    );
  }
}
process.exit(0);
