// src/app/projects/[projectId]/overall-schedule/page.tsx
import OverallScheduleClient from "./OverallScheduleClient";

export default async function OverallSchedulePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <OverallScheduleClient initialProjectId={projectId} />;
}
