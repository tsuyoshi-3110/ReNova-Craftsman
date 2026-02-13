// src/app/projects/[projectId]/chat/[roomId]/page.tsx
import ChatRoomClient from "./ChatRoomClient";

export const dynamic = "force-dynamic";

export default async function Page(
  props: { params: Promise<{ projectId: string; roomId: string }> },
) {
  const { projectId, roomId } = await props.params;
  return <ChatRoomClient initialProjectId={projectId} initialRoomId={roomId} />;
}
