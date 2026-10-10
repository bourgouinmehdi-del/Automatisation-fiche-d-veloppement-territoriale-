import { NextResponse } from "next/server";
import { getJob, getReport } from "@/lib/report/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (job) return NextResponse.json({ id, status: job.status, error: job.error, events: job.events });
  const r = await getReport(id);
  if (r) return NextResponse.json({ id, status: "done", events: [] });
  return NextResponse.json({ id, status: "unknown", events: [] }, { status: 404 });
}
