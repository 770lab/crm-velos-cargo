// Trouve TOUS les clients avec stats.livres > 0 et liste leurs livraisons
// + l'état réel de leurs vélos. But : comprendre l'écart 13 vs ~106.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const all = await db.collection("clients").get();
console.log("\n=== Clients avec stats.livres > 0 (état actuel base) ===\n");
let tot = 0;
const livresClients = [];
for (const d of all.docs) {
  const c = d.data();
  const l = c.stats?.livres ?? 0;
  if (l > 0) {
    livresClients.push({ id: d.id, name: c.entreprise || d.id, statsLivres: l, statsTotal: c.stats?.totalVelos ?? 0 });
    tot += l;
  }
}
console.log(`${livresClients.length} clients avec stats.livres > 0, total ${tot}\n`);
for (const c of livresClients) {
  // Vérifie en base velos
  const vSnap = await db.collection("velos").where("clientId", "==", c.id).get();
  const velos = vSnap.docs.map((d) => d.data()).filter((v) => v.annule !== true);
  const realLivres = velos.filter((v) => v.dateLivraisonScan).length;
  console.log(`  ${c.name.padEnd(35)} stats.livres=${String(c.statsLivres).padStart(3)}  réel=${String(realLivres).padStart(3)}  ${c.statsLivres === realLivres ? "✓" : "❌"}`);
}

// Maintenant : trouver TOUS les clients dont les vélos ont dateLivraisonScan
console.log("\n=== Recensement vélos avec dateLivraisonScan (vérité) ===\n");
const vAll = await db.collection("velos").get();
const livresParClient = new Map();
let totalReel = 0;
for (const d of vAll.docs) {
  const v = d.data();
  if (v.annule === true) continue;
  if (!v.dateLivraisonScan) continue;
  const cid = v.clientId;
  livresParClient.set(cid, (livresParClient.get(cid) || 0) + 1);
  totalReel++;
}
console.log(`Total vélos livrés (dateLivraisonScan posée, non annulés) : ${totalReel}`);
console.log(`Total stats.livres en base                                  : ${tot}\n`);

// Liste clients où mismatch
console.log("Clients où velos > stats (à corriger):");
for (const [cid, n] of livresParClient.entries()) {
  const cSnap = await db.collection("clients").doc(cid).get();
  const c = cSnap.data();
  const stat = c?.stats?.livres ?? 0;
  if (stat !== n) {
    console.log(`  ${(c?.entreprise || cid).padEnd(35)} stats=${String(stat).padStart(3)}  réel=${String(n).padStart(3)}  diff=${n - stat}`);
  }
}

process.exit(0);
