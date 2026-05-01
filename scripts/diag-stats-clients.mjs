// Vérifie les compteurs stats sur les clients touchés par le fix d'hier
// vs ce qu'il y a réellement dans la collection velos.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const CLIENT_IDS = [
  ["cmoa7mb0s02wsb2g26uvc9u5f", "ANADOLU DISTRIBUTION"],
  ["cmoa7mb1c032ab2g2b44lx6ho", "DOSTLAR FRANCE"],
  ["cmoa7mb3u03thb2g2mv1bx0ar", "USTAM FRANCE"],
  ["cmoa7masv01frb2g27co6q56o", "BATISOLE CONSTRUCTION"],
  ["cmoa7maxq02d6b2g2y9mna4h6", "GPCONSULTING"],
  ["cmoa7mb4703vdb2g2najdp2xo", "PRO CASH EUROPE"],
];

let totalLivresFromVelos = 0;
let totalLivresFromStats = 0;

console.log("\nClient                        | Stats(livres/total) | Velos(livres/total) | Diff");
console.log("-----------------------------+---------------------+---------------------+------");

for (const [cid, name] of CLIENT_IDS) {
  const cSnap = await db.collection("clients").doc(cid).get();
  const stats = cSnap.data()?.stats || {};
  const sLivres = stats.livres ?? 0;
  const sTotal = stats.totalVelos ?? 0;

  const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
  const velos = vSnap.docs.map((d) => d.data()).filter((v) => v.annule !== true);
  const vLivres = velos.filter((v) => v.dateLivraisonScan).length;
  const vTotal = velos.length;

  totalLivresFromVelos += vLivres;
  totalLivresFromStats += sLivres;

  const diff = sLivres === vLivres ? "✓" : `❌ ${vLivres - sLivres}`;
  console.log(
    `${name.padEnd(30)}| ${String(sLivres).padStart(3)}/${String(sTotal).padStart(4).padEnd(15)} | ${String(vLivres).padStart(3)}/${String(vTotal).padStart(4).padEnd(15)} | ${diff}`,
  );
}

console.log(`\nTotal stats.livres (échantillon) : ${totalLivresFromStats}`);
console.log(`Total dateLivraisonScan posée    : ${totalLivresFromVelos}`);

// Total global stats
let totalGlobal = 0;
const allClients = await db.collection("clients").get();
for (const d of allClients.docs) {
  totalGlobal += d.data()?.stats?.livres ?? 0;
}
console.log(`Total global stats.livres        : ${totalGlobal}`);

process.exit(0);
