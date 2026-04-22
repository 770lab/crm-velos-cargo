import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const rows: Array<{
    entreprise: string;
    contact?: string;
    email?: string;
    telephone?: string;
    adresse?: string;
    ville?: string;
    codePostal?: string;
    nbVelos: number;
  }> = body.rows;

  if (!rows?.length) {
    return Response.json({ error: "Aucune donnée" }, { status: 400 });
  }

  let importedClients = 0;
  let importedVelos = 0;

  for (const row of rows) {
    const nb = Number(row.nbVelos) || 0;
    const client = await prisma.client.create({
      data: {
        entreprise: row.entreprise?.trim() || "Sans nom",
        contact: row.contact?.trim() || null,
        email: row.email?.trim() || null,
        telephone: row.telephone?.trim() || null,
        adresse: row.adresse?.trim() || null,
        ville: row.ville?.trim() || null,
        codePostal: row.codePostal?.trim() || null,
        nbVelosCommandes: nb,
      },
    });

    if (nb > 0) {
      const prefix = client.entreprise.substring(0, 3).toUpperCase().replace(/\s/g, "X");
      const velosData = Array.from({ length: nb }, (_, i) => ({
        clientId: client.id,
        reference: `${prefix}-${String(i + 1).padStart(4, "0")}`,
      }));
      await prisma.velo.createMany({ data: velosData });
      importedVelos += nb;
    }
    importedClients++;
  }

  return Response.json({ importedClients, importedVelos });
}
