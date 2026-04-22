import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      velos: {
        include: { livraison: true },
        orderBy: { reference: "asc" },
      },
      livraisons: { orderBy: { datePrevue: "asc" } },
    },
  });

  if (!client) return Response.json({ error: "Client non trouvé" }, { status: 404 });
  return Response.json(client);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const client = await prisma.client.update({
    where: { id },
    data: body,
  });
  return Response.json(client);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.client.delete({ where: { id } });
  return Response.json({ ok: true });
}
