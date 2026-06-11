import type { ReactNode } from "react";

import ProjectAccessGuardClient from "./ProjectAccessGuardClient";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
};

export default async function ProjectLayout({ children, params }: LayoutProps) {
  const { projectId } = await params;

  return (
    <>
      <ProjectAccessGuardClient projectId={projectId} />
      {children}
    </>
  );
}
