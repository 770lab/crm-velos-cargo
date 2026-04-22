import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get("search") || "";
  const filter = request.nextUrl.searchParams.get("filter") || "all";

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { entreprise: { contains: search } },
      { contact: { contains: search } },
      { ville: { contains: search } },
    ];
  }

  if (filter === "docs_manquants") {
    where.OR = [
      { kbisRecu: false },
      { attestationRecue: false },
      { signatureOk: false },
    ];
  } else if (filter === "prets") {
    where.kbisRecu = true;
    where.attestationRecue = true;
    where.signatureOk = true;
  }

  const clients = await prisma.client.findMany({
    where,
    include: {
      _count: { select: { velos: true } },
      velos: {
        select: {
          certificatRecu: true,
          photoQrPrise: true,
          facturable: true,
          facture: true,
          livraisonId: true,
        },
      },
    },
    orderBy: { entreprise: "asc" },
  });

  const result = clients.map((c) => {
    const totalVelos = c.velos.length;
    const livres = c.velos.filter((v) => v.photoQrPrise).length;
    const certificats = c.velos.filter((v) => v.certificatRecu).length;
    const facturables = c.velos.filter((v) => v.facturable).length;
    const factures = c.velos.filter((v) => v.facture).length;
    const { velos: _, ...client } = c;
    return {
      ...client,
      stats: { totalVelos, livres, certificats, facturables, factures },
    };
  });

  return Response.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const client = await prisma.client.create({
    data: {
      entreprise: body.entreprise,
      contact: body.contact || null,
      email: body.email || null,
      telephone: body.telephone || null,
      adresse: body.adresse || null,
      ville: body.ville || null,
      codePostal: body.codePostal || null,
      nbVelosCommandes: body.nbVelosCommandes || 0,
      notes: body.notes || null,
    },
  });

  if (body.nbVelosCommandes > 0) {
    const velosData = Array.from({ length: body.nbVelosCommandes }, (_, i) => ({
      clientId: client.id,
      reference: `${client.entreprise.substring(0, 3).toUpperCase()}-${String(i + 1).padStart(4, "0")}`,
    }));
    await prisma.velo.createMany({ data: velosData });
  }

  return Response.json(client, { status: 201 });
}
