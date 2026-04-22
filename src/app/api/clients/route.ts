import { gasGet } from "@/lib/gas";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get("search") || "";
  const filter = request.nextUrl.searchParams.get("filter") || "all";
  const params: Record<string, string> = {};
  if (search) params.search = search;
  if (filter !== "all") params.filter = filter;
  const result = await gasGet("getClients", params);
  return Response.json(result);
}
