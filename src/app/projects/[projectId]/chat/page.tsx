// src/app/projects/[projectId]/chat/page.tsx
import { Suspense } from "react";
import ChatGateClient from "./ChatGateClient";

export const dynamic = "force-dynamic";

export default async function Page(
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;

  return (
    <Suspense fallback={<div className="p-6 text-sm font-bold">入室準備中...</div>}>
      <ChatGateClient initialProjectId={projectId} />
    </Suspense>
  );
}
