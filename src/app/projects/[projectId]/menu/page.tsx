// src/app/projects/[projectId]/menu/page.tsx
import MenuClient from "./MenuClient";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function Page({ params }: PageProps) {
  const { projectId } = await params;
  return <MenuClient initialProjectId={projectId} />;
}
