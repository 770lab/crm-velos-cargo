import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function GET() {
  const livraisons = await prisma.livraison.findMany({
    include: {
      client: { select: { entreprise: true, ville: true, adresse: true } },
      _count: { select: { velos: true } },
    },
    orderBy: { datePrevue: "asc" },
  });
  return Response.json(livraisons);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const livraison = await prisma.livraison.create({
    data: {
      clientId: body.clientId,
      datePrevue: body.datePrevue ? new Date(body.datePrevue) : null,
      notes: body.notes || null,
    },
  });

  if (body.veloIds?.length) {
    await prisma.velo.updateMany({
      where: { id: { in: body.veloIds } },
      data: { livraisonId: livraison.id },
    });
  }

  return Response.json(livraison, { status: 201 });
}
