import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "prisma", "dev.db");
const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

const clients = await prisma.client.findMany({
  include: { velos: true },
  orderBy: { entreprise: "asc" },
});

const clientsHeaders = [
  "id", "entreprise", "siren", "contact", "email", "telephone",
  "adresse", "ville", "codePostal", "departement",
  "nbVelosCommandes", "operationNumero", "referenceOperation", "apporteur",
  "devisSignee", "kbisRecu", "attestationRecue", "signatureOk", "inscriptionBicycle",
  "latitude", "longitude", "modeLivraison", "notes"
];

const clientsRows = clients.map(c => clientsHeaders.map(h => {
  const v = c[h];
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v ?? "";
}));

const velosHeaders = [
  "id", "reference", "qrCode", "certificatRecu", "certificatNumero",
  "photoQrPrise", "facturable", "facture", "clientId", "livraisonId"
];

const velosRows = [];
for (const c of clients) {
  for (const v of c.velos) {
    velosRows.push(velosHeaders.map(h => {
      const val = v[h];
      if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
      return val ?? "";
    }));
  }
}

const output = {
  clients: { headers: clientsHeaders, rows: clientsRows },
  velos: { headers: velosHeaders, rows: velosRows },
};

writeFileSync(join(__dirname, "..", "gas", "data-export.json"), JSON.stringify(output, null, 2));

console.log(`Export: ${clientsRows.length} clients, ${velosRows.length} vélos`);
await prisma.$disconnect();
