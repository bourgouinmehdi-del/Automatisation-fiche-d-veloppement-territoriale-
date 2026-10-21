import { getReport } from "@/lib/report/store";
import { compareCol } from "@/lib/report/compare";
import Compare from "@/components/Compare";

export const dynamic = "force-dynamic";

/** Comparaison de 2 ou 3 fiches commune : /comparer?ids=a,b,c */
export default async function Page({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids = "" } = await searchParams;
  const list = ids.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const reports = (await Promise.all(list.map((id) => getReport(id)))).filter((r): r is NonNullable<typeof r> => !!r && r.sections.some((s) => s.id === "LFI"));
  return <Compare cols={reports.map(compareCol)} />;
}
