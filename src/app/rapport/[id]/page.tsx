import { notFound } from "next/navigation";
import { getReport } from "@/lib/report/store";
import { hasLocator, locatorSvg } from "@/lib/render/svg";
import { freshness } from "@/lib/render/html";
import { SOURCES } from "@/lib/collectors/catalog";
import ReportView from "@/components/ReportView";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await getReport(id);
  if (!report) notFound();
  const locator = hasLocator(report.commune.departement.code) ? locatorSvg(report.commune.departement.code, report.commune.departement.nom, 300) : null;
  return <ReportView report={report} locator={locator} freshness={freshness(report)} catalog={SOURCES} />;
}
