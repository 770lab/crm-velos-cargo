import { gasGet, gasPost } from "@/lib/gas";
import { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const result = await gasPost("updateLivraison", { id, data: body });
  return Response.json(result);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await gasGet("deleteLivraison", { id });
  return Response.json(result);
}
