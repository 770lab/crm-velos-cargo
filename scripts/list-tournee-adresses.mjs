// Liste les adresses des clients d'une tournée dans l'ordre actuel,
// pour aider à insérer manuellement un client ajouté après coup.
import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const TOURNEE_ID = process.argv[2] || "818b8963";

function ordreFromNotes(notes) {
  if (typeof notes !== "string") return null;
  const m = notes.match(/arr[êe]t\s+(\d+)\s*\//i);
  return m ? parseInt(m[1], 10) : null;
}

const snap = await db
  .collection("livraisons")
  .where("tourneeId", "==", TOURNEE_ID)
  .get();

const enriched = snap.docs.map((d) => {
  const data = d.data();
  const ordre =
    typeof data.ordre === "number" ? data.ordre : ordreFromNotes(data.notes);
  return { id: d.id, data, ordre };
});

enriched.sort((a, b) => {
  if (a.ordre != null && b.ordre != null) return a.ordre - b.ordre;
  if (a.ordre != null) return -1;
  if (b.ordre != null) return 1;
  return 0;
});

console.log(`\n=== Tournée ${TOURNEE_ID} : adresses dans l'ordre ===\n`);
enriched.forEach((e, i) => {
  const cs = e.data.clientSnapshot || {};
  const ordreStr = e.ordre != null ? `#${e.ordre}` : "(sans ordre)";
  const annule = e.data.statut === "annulee" ? " ⛔ANNULÉ" : "";
  console.log(
    `${ordreStr.padEnd(15)} ${(cs.entreprise || "?").padEnd(34)}${annule}`,
  );
  console.log(
    `${" ".repeat(15)}   ${cs.codePostal || "?"} ${cs.ville || "?"} — ${cs.adresse || "?"}`,
  );
  if (cs.lat && cs.lng) {
    console.log(`${" ".repeat(15)}   GPS ${cs.lat.toFixed(4)},${cs.lng.toFixed(4)}`);
  }
  console.log();
});
process.exit(0);
