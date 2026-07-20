// src/app/projects/[projectId]/craftsmen/page.tsx
import CraftsmenClient from "./CraftsmenClient";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <CraftsmenClient initialProjectId={projectId} />;
}
