// Identifie les clients potentiels du groupe Firat Food (avant flag).
// Critères : entreprise contient "MARCHE IST" ou "MILLENIUM" ou "FIRAT".
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("clients").get();
const candidats = [];
const motsCles = [/marche\s*ist/i, /millenium/i, /firat/i];
for (const d of snap.docs) {
  const o = d.data();
  const nom = String(o.entreprise || "");
  if (motsCles.some((re) => re.test(nom))) {
    candidats.push({
      id: d.id,
      entreprise: nom,
      ville: o.ville || "",
      apporteur: o.apporteur || "",
      groupeActuel: o.groupe || o.groupeClient || null,
    });
  }
}
console.log(`\n=== ${candidats.length} clients candidats groupe Firat ===\n`);
for (const c of candidats) {
  console.log(`  ${c.id.padEnd(28)} | ${c.entreprise.padEnd(40)} | ${c.ville.padEnd(20)} | groupe=${c.groupeActuel || "-"} | apporteur=${c.apporteur}`);
}
process.exit(0);
