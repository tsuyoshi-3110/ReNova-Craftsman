// src/app/projects/[projectId]/managers/page.tsx
import ManagersClient from "./ManagersClient";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ManagersClient initialProjectId={projectId} />;
}
