// src/app/projects/[projectId]/board/page.tsx
import BoardClient from "./BoardClient";

export default async function Page(
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  return <BoardClient initialProjectId={projectId} />;
}
