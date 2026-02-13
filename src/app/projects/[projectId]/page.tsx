// src/app/projects/[projectId]/page.tsx
import { redirect } from "next/navigation";

export default function Page({ params }: { params: { projectId: string } }) {
  redirect(`/projects/${encodeURIComponent(params.projectId)}/menu`);
}
