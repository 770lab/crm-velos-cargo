import { gasGet, gasPost } from "@/lib/gas";
import { NextRequest } from "next/server";

export async function GET() {
  const result = await gasGet("getLivraisons");
  return Response.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await gasPost("createLivraison", body);
  return Response.json(result, { status: 201 });
}
