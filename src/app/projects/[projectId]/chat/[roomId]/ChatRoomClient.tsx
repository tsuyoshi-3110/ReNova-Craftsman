/* eslint-disable @next/next/no-img-element */
"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { Loader2, Paperclip, Send } from "lucide-react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  Timestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  getDownloadURL,
  ref as storageRef,
  uploadBytes,
} from "firebase/storage";

import { auth, db, storage } from "@/lib/firebaseClient";

type ChatRole = "manager" | "craftsman" | "resident" | "proclink";

type ChatProfile = {
  uid: string;
  name: string;
  role: ChatRole;
  projectId: string;
  projectName: string | null;
};

type ChatMessage = {
  text?: string;
  senderUid?: string;
  senderName?: string;
  senderRole?: ChatRole;
  createdAt?: unknown;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
};

type ChatReadState = {
  uid?: string;
  name?: string;
  role?: ChatRole;
  lastReadAt?: unknown;
};

function toMillis(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (
    typeof v === "object" &&
    v !== null &&
    "seconds" in v &&
    typeof (v as { seconds: unknown }).seconds === "number"
  ) {
    const seconds = (v as { seconds: number }).seconds;
    const nanoseconds =
      "nanoseconds" in v &&
      typeof (v as { nanoseconds?: unknown }).nanoseconds === "number"
        ? ((v as { nanoseconds: number }).nanoseconds ?? 0)
        : 0;
    return seconds * 1000 + Math.floor(nanoseconds / 1000000);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return 0;
}

type MemberRole = "manager" | "craftsman" | "resident" | "proclink";
type Role = "owner" | "member";

type ProjectMemberDoc = {
  uid?: string;
  role?: Role;
  memberRole?: MemberRole;
  name?: string;
  displayName?: string;
  company?: string;
  phone?: string;
  address?: string;
  email?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  joinedAt?: unknown;
};

type ProjectPhotoOption = {
  id: string;
  url: string;
  name: string;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function mapMsg(d: QueryDocumentSnapshot<DocumentData>): {
  id: string;
  data: ChatMessage;
} {
  return { id: d.id, data: d.data() as ChatMessage };
}

function isImageType(fileType: string): boolean {
  return fileType.startsWith("image/");
}

function isVideoType(fileType: string): boolean {
  return fileType.startsWith("video/");
}

function isPdfType(fileType: string): boolean {
  return fileType === "application/pdf";
}

function formatFileSize(size?: number): string {
  if (!size || size <= 0) return "";
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)}KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

async function getVideoDurationSeconds(file: File): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("動画の長さを取得できませんでした。"));
    };
    video.src = objectUrl;
  });
}

function pickPhotoName(
  data: Record<string, unknown>,
  fallbackId: string,
): string {
  return (
    toNonEmptyString(data.fileName) ||
    toNonEmptyString(data.name) ||
    toNonEmptyString(data.originalFileName) ||
    `工事写真_${fallbackId}`
  );
}

function pickPhotoDirectUrl(data: Record<string, unknown>): string {
  return (
    toNonEmptyString(data.url) ||
    toNonEmptyString(data.imageUrl) ||
    toNonEmptyString(data.photoUrl) ||
    toNonEmptyString(data.downloadURL) ||
    toNonEmptyString(data.downloadUrl) ||
    toNonEmptyString(data.originalUrl)
  );
}

function pickPhotoStoragePath(data: Record<string, unknown>): string {
  return (
    toNonEmptyString(data.storagePath) ||
    toNonEmptyString(data.path) ||
    toNonEmptyString(data.originalPath)
  );
}

async function getMember(
  projectId: string,
  uid: string,
): Promise<ProjectMemberDoc | null> {
  const ref1 = doc(db, "projects", projectId, "members", uid);
  const snap1 = await getDoc(ref1);
  if (snap1.exists()) {
    return snap1.data() as ProjectMemberDoc;
  }

  const col = collection(db, "projects", projectId, "members");
  const qy = query(col, where("uid", "==", uid));
  const qs = await getDocs(qy);
  if (!qs.empty) {
    return qs.docs[0].data() as ProjectMemberDoc;
  }

  return null;
}

export default function ChatRoomClient(props: {
  initialProjectId: string;
  initialRoomId: string;
}) {
  const router = useRouter();

  const projectId = useMemo(
    () => toNonEmptyString(props.initialProjectId),
    [props.initialProjectId],
  );
  const roomId = useMemo(
    () => toNonEmptyString(props.initialRoomId) || "main",
    [props.initialRoomId],
  );

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ChatProfile | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [msgs, setMsgs] = useState<Array<{ id: string; data: ChatMessage }>>(
    [],
  );
  const [readStates, setReadStates] = useState<Record<string, ChatReadState>>(
    {},
  );
  const [memberNameMap, setMemberNameMap] = useState<Record<string, string>>(
    {},
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [photoPickerOpen, setPhotoPickerOpen] = useState(false);
  const [photoPickerLoading, setPhotoPickerLoading] = useState(false);
  const [photoOptions, setPhotoOptions] = useState<ProjectPhotoOption[]>([]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 160);
    el.style.height = `${Math.max(nextHeight, 44)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    if (!projectId) {
      setErrorText("現場IDが不正です。");
      setLoading(false);
      return;
    }

    let mounted = true;

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          if (!mounted) return;
          router.replace("/login");
          return;
        }

        const mem = await getMember(projectId, u.uid);
        if (!mounted) return;

        if (!mem) {
          setProfile(null);
          setErrorText("この現場のメンバー情報が見つかりません。");
          setLoading(false);
          return;
        }

        const name =
          toNonEmptyString(mem.displayName) ||
          toNonEmptyString(mem.name) ||
          toNonEmptyString(u.displayName) ||
          "不明";

        const role =
          (toNonEmptyString(mem.memberRole) as ChatRole) || "craftsman";

        setProfile({
          uid: u.uid,
          name,
          role,
          projectId,
          projectName: null,
        });

        setErrorText(null);
        setLoading(false);
      } catch (e) {
        console.log("chat profile error:", e);
        if (!mounted) return;
        setProfile(null);
        setErrorText("プロフィール取得に失敗しました。");
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [projectId, router]);

  useEffect(() => {
    if (!projectId) return;

    const colRef = collection(
      db,
      "projects",
      projectId,
      "chatRooms",
      roomId,
      "messages",
    );
    const qy = query(colRef, orderBy("createdAt", "asc"), limit(300));

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: Array<{ id: string; data: ChatMessage }> = [];
        snap.forEach((d) => rows.push(mapMsg(d)));
        setMsgs(rows);
      },
      (err) => {
        console.log("chat onSnapshot error:", err);
        setErrorText("チャットの取得に失敗しました。");
      },
    );

    return () => unsub();
  }, [projectId, roomId]);

  useEffect(() => {
    if (!projectId) return;

    const colRef = collection(
      db,
      "projects",
      projectId,
      "chatRooms",
      roomId,
      "readStates",
    );
    const qy = query(colRef, limit(100));

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const next: Record<string, ChatReadState> = {};
        snap.forEach((d) => {
          next[d.id] = d.data() as ChatReadState;
        });
        setReadStates(next);
      },
      (err) => {
        console.log("chat readStates onSnapshot error:", err);
      },
    );

    return () => unsub();
  }, [projectId, roomId]);

  useEffect(() => {
    if (!projectId) return;

    const colRef = collection(db, "projects", projectId, "members");
    const unsub = onSnapshot(
      colRef,
      (snap) => {
        const next: Record<string, string> = {};
        snap.forEach((d) => {
          const data = d.data() as ProjectMemberDoc;
          const uid = toNonEmptyString(data.uid) || d.id;
          const name =
            toNonEmptyString(data.displayName) ||
            toNonEmptyString(data.name) ||
            "不明";

          if (uid) {
            next[uid] = name;
          }
        });
        setMemberNameMap(next);
      },
      (err) => {
        console.log("members onSnapshot error:", err);
      },
    );

    return () => unsub();
  }, [projectId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const threshold = 40;
    const atBottom =
      el.scrollHeight - (el.scrollTop + el.clientHeight) < threshold;
    stickToBottomRef.current = atBottom;
  }

  async function onSelectFile(file: File | null) {
    if (!file) return;

    const fileType = file.type || "";
    const allowed =
      isImageType(fileType) || isVideoType(fileType) || isPdfType(fileType);

    if (!allowed) {
      setErrorText("画像・動画・PDFのみ添付できます。");
      return;
    }

    if (isVideoType(fileType)) {
      try {
        const duration = await getVideoDurationSeconds(file);
        if (duration > 60) {
          setErrorText("動画は1分以内のものだけアップロードできます。");
          return;
        }
      } catch {
        setErrorText("動画の長さを確認できませんでした。");
        return;
      }
    }

    setErrorText(null);
    setSelectedFile(file);
  }

  async function openProjectPhotoPicker() {
    if (!projectId) return;

    try {
      setPhotoPickerLoading(true);
      setErrorText(null);

      const photoColRef = collection(
        db,
        "projects",
        projectId,
        "subtitles",
        "RxCGIA3e1fTB0JruN5rY",
        "workTypes",
        "za1iNGWvWkmSh7DI1pAW",
        "photos",
      );

      const snap = await getDocs(query(photoColRef, limit(100)));
      const next: ProjectPhotoOption[] = [];

      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;
        let url = pickPhotoDirectUrl(raw);

        if (!url) {
          const storagePath = pickPhotoStoragePath(raw);
          if (storagePath) {
            try {
              url = await getDownloadURL(storageRef(storage, storagePath));
            } catch {
              url = "";
            }
          }
        }

        if (!url) continue;

        next.push({
          id: d.id,
          url,
          name: pickPhotoName(raw, d.id),
        });
      }

      setPhotoOptions(next);
      setPhotoPickerOpen(true);
    } catch (e) {
      console.log("load project photos error:", e);
      setErrorText("工事写真の取得に失敗しました。");
    } finally {
      setPhotoPickerLoading(false);
    }
  }

  async function sendProjectPhotoAttachment(photo: ProjectPhotoOption) {
    if (!profile) return;

    try {
      setSending(true);
      setErrorText(null);

      const colRef = collection(
        db,
        "projects",
        projectId,
        "chatRooms",
        roomId,
        "messages",
      );

      await addDoc(colRef, {
        text: "",
        senderUid: profile.uid,
        senderName: profile.name,
        senderRole: profile.role,
        createdAt: serverTimestamp(),
        fileUrl: photo.url,
        fileName: photo.name,
        fileType: "image/jpeg",
        fileSize: 0,
      });

      setPhotoPickerOpen(false);
      stickToBottomRef.current = true;
    } catch (e) {
      console.log("send project photo error:", e);
      setErrorText("工事写真の送信に失敗しました。通信状況をご確認ください。");
    } finally {
      setSending(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  async function markRoomAsRead(current: ChatProfile) {
    try {
      const ref = doc(
        db,
        "projects",
        current.projectId,
        "chatRooms",
        roomId,
        "readStates",
        current.uid,
      );

      await setDoc(
        ref,
        {
          uid: current.uid,
          name: current.name,
          role: current.role,
          projectId: current.projectId,
          lastReadAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.log("mark read error:", e);
    }
  }

  useEffect(() => {
    if (!profile) return;

    void markRoomAsRead(profile);

    const onFocus = () => {
      void markRoomAsRead(profile);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void markRoomAsRead(profile);
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [profile, msgs.length, roomId, markRoomAsRead]);

  async function send() {
    if (!profile) return;
    const t = toNonEmptyString(text);
    if (!t && !selectedFile) return;

    try {
      setSending(true);
      setUploadingFile(Boolean(selectedFile));
      setErrorText(null);

      const colRef = collection(
        db,
        "projects",
        projectId,
        "chatRooms",
        roomId,
        "messages",
      );

      if (selectedFile) {
        const messageRef = await addDoc(colRef, {
          text: t || "",
          senderUid: profile.uid,
          senderName: profile.name,
          senderRole: profile.role,
          createdAt: serverTimestamp(),
          fileUrl: "",
          fileName: selectedFile.name,
          fileType: selectedFile.type || "application/octet-stream",
          fileSize: selectedFile.size || 0,
        });

        const safeName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileRef = storageRef(
          storage,
          `projects/${projectId}/chatRooms/${roomId}/messages/${messageRef.id}/${Date.now()}_${safeName}`,
        );

        await uploadBytes(fileRef, selectedFile, {
          contentType: selectedFile.type || undefined,
        });
        const downloadUrl = await getDownloadURL(fileRef);

        await updateDoc(messageRef, {
          fileUrl: downloadUrl,
          fileName: selectedFile.name,
          fileType: selectedFile.type || "application/octet-stream",
          fileSize: selectedFile.size || 0,
        });
      } else {
        await addDoc(colRef, {
          text: t,
          senderUid: profile.uid,
          senderName: profile.name,
          senderRole: profile.role,
          createdAt: serverTimestamp(),
        });
      }

      setText("");
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      requestAnimationFrame(() => {
        resizeTextarea();
      });
      stickToBottomRef.current = true;
    } catch (e) {
      console.log("send message/file error:", e);
      setErrorText("送信に失敗しました。通信状況をご確認ください。");
    } finally {
      setSending(false);
      setUploadingFile(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-10">
          <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
              読み込み中...
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (errorText) {
    return (
      <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto w-full max-w-md px-4 py-10">
          <div className="rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
              現場チャット
            </div>
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">{errorText}</p>
            </div>

            <div className="mt-6">
              <button
                type="button"
                onClick={() =>
                  router.push(`/projects/${encodeURIComponent(projectId)}/menu`)
                }
                className="w-full rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                           dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
              >
                メニューへ戻る
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!profile) {
    return null;
  }

  const otherReaders = Object.entries(readStates)
    .filter(([uid]) => uid !== profile.uid)
    .map(([uid, state]) => ({
      uid,
      name: toNonEmptyString(state.name) || memberNameMap[uid] || "不明",
      readAtMillis: toMillis(state.lastReadAt),
    }))
    .filter((reader) => reader.readAtMillis > 0);

  const hasOtherParticipant = otherReaders.length > 0;

  return (
    <main
      className="flex min-h-0 flex-col overflow-hidden bg-gray-50 dark:bg-gray-950"
      style={{ height: "var(--app-vh, 100dvh)" }}
    >
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              現場チャット
            </div>
            <div className="truncate text-xs font-bold text-gray-500 dark:text-gray-400">
              {profile.name}（{profile.role === "manager" ? "監督" : "職人"}）
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              router.push(`/projects/${encodeURIComponent(projectId)}/menu`)
            }
            className="shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            戻る
          </button>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 h-full w-full max-w-2xl flex-1 flex-col px-2 py-2 pb-24 sm:px-3 sm:py-3 sm:pb-26">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2 pb-28 sm:px-3 sm:py-3 sm:pb-32"
          >
            {msgs.length === 0 ? (
              <div className="rounded-xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                まだメッセージがありません。
              </div>
            ) : (
              <div className="grid min-w-0 gap-2">
                {msgs.map((m) => {
                  const senderUid = toNonEmptyString(m.data.senderUid);
                  const mine = senderUid === profile.uid;
                  const dmTargetUid = !mine && senderUid ? senderUid : "";
                  const sender =
                    (senderUid ? memberNameMap[senderUid] : "") ||
                    toNonEmptyString(m.data.senderName) ||
                    "不明";
                  const body = toNonEmptyString(m.data.text);
                  const fileUrl = toNonEmptyString(m.data.fileUrl);
                  const fileName =
                    toNonEmptyString(m.data.fileName) || "添付ファイル";
                  const fileType = toNonEmptyString(m.data.fileType);
                  const fileSize =
                    typeof m.data.fileSize === "number" ? m.data.fileSize : 0;
                  const badge =
                    m.data.senderRole === "manager" ? "監督" : "職人";
                  const messageMillis = toMillis(m.data.createdAt);
                  const readersForMessage =
                    messageMillis > 0
                      ? otherReaders.filter(
                          (reader) => reader.readAtMillis >= messageMillis,
                        )
                      : [];
                  const isReadByOther = readersForMessage.length > 0;
                  const readCount = readersForMessage.length;

                  return (
                    <div
                      key={m.id}
                      className={
                        mine ? "flex justify-end" : "flex justify-start"
                      }
                    >
                      <div className="max-w-[90%]">
                        {mine ? (
                          <div
                            className={[
                              "rounded-2xl border px-3 py-2",
                              "bg-blue-600 text-white border-blue-600",
                            ].join(" ")}
                          >
                            {body ? (
                              <div className="whitespace-pre-wrap text-sm font-bold leading-relaxed">
                                {body}
                              </div>
                            ) : null}
                            {fileUrl ? (
                              <div className={body ? "mt-2" : ""}>
                                {isImageType(fileType) ? (
                                  <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block"
                                  >
                                    <img
                                      src={fileUrl}
                                      alt={fileName}
                                      className="max-h-64 w-auto rounded-xl border border-white/20 object-contain"
                                    />
                                  </a>
                                ) : isVideoType(fileType) ? (
                                  <video
                                    controls
                                    preload="metadata"
                                    className="max-h-72 w-full rounded-xl border border-white/20 bg-black"
                                    src={fileUrl}
                                  />
                                ) : (
                                  <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-bold text-white underline-offset-2 hover:underline"
                                  >
                                    PDF: {fileName}
                                    {fileSize
                                      ? ` (${formatFileSize(fileSize)})`
                                      : ""}
                                  </a>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={!dmTargetUid}
                            onClick={() => {
                              if (!dmTargetUid) return;
                              router.push(
                                `/dm/${encodeURIComponent(dmTargetUid)}?projectId=${encodeURIComponent(projectId)}`,
                              );
                            }}
                            className={[
                              "w-full rounded-2xl border px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-100",
                              "bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800 dark:hover:bg-gray-900",
                            ].join(" ")}
                          >
                            <div className="mb-1 text-[11px] font-extrabold opacity-80">
                              {sender}（{badge}）
                            </div>
                            {body ? (
                              <div className="whitespace-pre-wrap text-sm font-bold leading-relaxed">
                                {body}
                              </div>
                            ) : null}
                            {fileUrl ? (
                              <div className={body ? "mt-2" : ""}>
                                {isImageType(fileType) ? (
                                  <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block"
                                  >
                                    <img
                                      src={fileUrl}
                                      alt={fileName}
                                      className="max-h-64 w-auto rounded-xl border border-gray-200 object-contain dark:border-gray-700"
                                    />
                                  </a>
                                ) : isVideoType(fileType) ? (
                                  <video
                                    controls
                                    preload="metadata"
                                    className="max-h-72 w-full rounded-xl border border-gray-200 bg-black dark:border-gray-700"
                                    src={fileUrl}
                                  />
                                ) : (
                                  <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-900 underline-offset-2 hover:underline dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                  >
                                    PDF: {fileName}
                                    {fileSize
                                      ? ` (${formatFileSize(fileSize)})`
                                      : ""}
                                  </a>
                                )}
                              </div>
                            ) : null}
                          </button>
                        )}

                        {mine && (
                          <div className="mt-1 px-1 text-right text-[11px] font-extrabold text-gray-500 dark:text-gray-400">
                            {hasOtherParticipant
                              ? isReadByOther
                                ? `既読 ${readCount}人`
                                : "未読"
                              : "未読"}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {photoPickerOpen && (
            <div
              className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
              onClick={() => setPhotoPickerOpen(false)}
            >
              <div
                className="w-full max-w-3xl rounded-2xl border bg-white p-4 shadow-xl dark:border-gray-800 dark:bg-gray-900"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                    工事写真を選択
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhotoPickerOpen(false)}
                    className="rounded-lg border bg-white px-3 py-1.5 text-xs font-extrabold text-gray-900 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
                  >
                    閉じる
                  </button>
                </div>

                {photoPickerLoading ? (
                  <div className="mt-4 text-sm font-bold text-gray-600 dark:text-gray-300">
                    読み込み中...
                  </div>
                ) : photoOptions.length === 0 ? (
                  <div className="mt-4 text-sm font-bold text-gray-600 dark:text-gray-300">
                    送信できる工事写真がありません。
                  </div>
                ) : (
                  <div className="mt-4 grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
                    {photoOptions.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        onClick={() => void sendProjectPhotoAttachment(photo)}
                        disabled={sending}
                        className="overflow-hidden rounded-xl border bg-white text-left hover:bg-gray-50 disabled:opacity-60 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900"
                      >
                        <img
                          src={photo.url}
                          alt={photo.name}
                          className="h-32 w-full object-cover"
                        />
                        <div className="px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-100">
                          <div className="line-clamp-2">{photo.name}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white px-2 py-2 pb-[calc(env(safe-area-inset-bottom)+8px)] dark:border-gray-800 dark:bg-gray-900 sm:px-3 sm:py-3 sm:pb-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,application/pdf"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0] ?? null;
                await onSelectFile(file);
              }}
            />
            <div className="mx-auto flex w-full min-w-0 max-w-2xl items-end gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending || uploadingFile}
                aria-label="添付"
                title="添付"
                className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-xl border bg-white text-gray-900 disabled:opacity-60 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 sm:h-11 sm:w-11"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => void openProjectPhotoPicker()}
                disabled={sending || photoPickerLoading || uploadingFile}
                aria-label="工事写真添付"
                title="工事写真添付"
                className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-xl border bg-white text-gray-900 disabled:opacity-60 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 sm:h-11 sm:w-11"
              >
                <img
                  src="/proclinkIcon128.png"
                  alt="工事写真添付"
                  className="h-6 w-6 object-contain"
                />
              </button>

              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onInput={resizeTextarea}
                placeholder="メッセージを入力..."
                rows={1}
                className="min-h-11 max-h-40 min-w-0 flex-1 resize-none overflow-hidden rounded-xl border px-3 py-2 font-bold text-gray-900 focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                style={{ fontSize: 16 }}
                disabled={sending}
              />

              <button
                type="button"
                onClick={() => void send()}
                disabled={
                  sending ||
                  uploadingFile ||
                  (!toNonEmptyString(text) && !selectedFile)
                }
                className="shrink-0 inline-flex h-10 items-center gap-1 rounded-xl bg-blue-600 px-2.5 py-2 text-sm font-extrabold text-white disabled:opacity-60 sm:h-11 sm:gap-2 sm:px-4"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    送信中
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    送信
                  </>
                )}
              </button>
            </div>

            {selectedFile ? (
              <div className="mx-auto mt-2 w-full max-w-2xl text-[11px] font-bold text-gray-600 dark:text-gray-300">
                添付予定: {selectedFile.name}
                {selectedFile.size
                  ? ` (${formatFileSize(selectedFile.size)})`
                  : ""}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFile(null);
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                  }}
                  className="ml-2 underline"
                >
                  取消
                </button>
              </div>
            ) : null}

            <div className="mx-auto mt-2 w-full max-w-2xl text-[11px] font-bold text-gray-500 dark:text-gray-400">
              ※
              画像・動画・PDFを添付できます。動画は1分以内です。工事写真添付から現場写真も送信できます。
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
