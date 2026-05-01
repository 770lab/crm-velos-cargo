// Diag pourquoi le bon d'enlèvement TOURNEE 38 n'apparaît pas côté CRM
// alors que Yoann a reçu le mail à 08:48 (30-04). Cause probable : sync
// gas-inbox pas encore passé, OU Gemini n'a pas extrait le numéro 38.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

console.log("\n=== Tournées du 30/04/2026 ===");
const livSnap = await db.collection("livraisons")
  .where("datePrevue", ">=", new Date("2026-04-30T00:00:00"))
  .where("datePrevue", "<", new Date("2026-05-01T00:00:00"))
  .get();
const numerosEnBase = new Set();
for (const d of livSnap.docs) {
  const data = d.data();
  if (typeof data.numero === "number") numerosEnBase.add(data.numero);
  if (typeof data.tourneeNumero === "number") numerosEnBase.add(data.tourneeNumero);
}
console.log("Numéros tournées présents :", [...numerosEnBase].sort((a, b) => a - b));

console.log("\n=== Bons d'enlèvement les plus récents (top 15) ===");
const beSnap = await db.collection("bonsEnlevement")
  .orderBy("createdAt", "desc")
  .limit(15)
  .get();
for (const d of beSnap.docs) {
  const b = d.data();
  const dt = b.createdAt?.toDate?.()?.toISOString().slice(0, 19) || "?";
  console.log(`  ${dt} · numero=${b.tourneeNumero ?? "?"} · qte=${b.quantite ?? "?"} · ref="${(b.tourneeRef || "").slice(0, 40)}" · doc=${(b.numeroDoc || "?").toString().slice(-6)} · driveUrl=${b.driveUrl ? "✓" : "✗"} · matched=${b.tourneeId ? "✓" : "✗"}`);
}

console.log("\n=== Recherche 'TOURNEE 38' dans bonsEnlevement ===");
const all = await db.collection("bonsEnlevement").get();
const matches38 = [];
for (const d of all.docs) {
  const b = d.data();
  const blob = JSON.stringify(b);
  if (/tournee\s*38\b|"tourneeNumero":\s*38/i.test(blob)) {
    matches38.push({ id: d.id, ...b });
  }
}
console.log(`  ${matches38.length} match(s)`);
for (const m of matches38) {
  console.log(`  doc=${m.id}`, JSON.stringify({
    tourneeNumero: m.tourneeNumero,
    tourneeRef: m.tourneeRef,
    quantite: m.quantite,
    numeroDoc: m.numeroDoc,
    tourneeId: m.tourneeId,
    createdAt: m.createdAt?.toDate?.()?.toISOString(),
  }, null, 2));
}

process.exit(0);
