// src/app/projects/[projectId]/period-chart/page.tsx
import PeriodChartClient from "./PeriodChartClient";

export default async function PeriodChartPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PeriodChartClient initialProjectId={projectId} />;
}
