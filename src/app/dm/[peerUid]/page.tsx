"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  getDownloadURL,
  ref as storageRef,
  uploadBytes,
} from "firebase/storage";
import { Loader2, Paperclip, Send } from "lucide-react";

import { auth, db, storage } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

/** -----------------------------
 * Types
 * ----------------------------*/
type Msg = {
  text?: string;

  senderUid?: string;
  senderName?: string;
  toUid?: string;
  readBy?: string[];

  createdAt?: unknown;
  createdAtMs?: number;

  // craftsman 旧
  fileUrl?: string;
  fileName?: string;
  fileType?: string; // mime

  // ✅ Renova 互換（受信表示用）
  mediaUrl?: string;
  mediaType?: "image" | "video" | "pdf" | null;
};

type Member = {
  uid?: string;
  role?: string;
  name?: string;
  company?: string;
  phone?: string;
};

/** -----------------------------
 * Utils
 * ----------------------------*/
function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function dmRoomId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function mapMsg(
  sourceKey: string,
  d: QueryDocumentSnapshot<DocumentData>,
): { id: string; roomId: string; docId: string; data: Msg } {
  // room混在でも衝突しないよう sourceKey を付ける
  return {
    id: `${sourceKey}:${d.id}`,
    roomId: sourceKey,
    docId: d.id,
    data: d.data() as Msg,
  };
}

function resolveCreatedAtMs(msg: Msg): number {
  if (typeof msg.createdAtMs === "number" && Number.isFinite(msg.createdAtMs)) {
    return msg.createdAtMs;
  }

  const v = msg.createdAt;

  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  if (v instanceof Date) return v.getTime();

  if (
    typeof v === "object" &&
    v !== null &&
    "toMillis" in (v as Record<string, unknown>)
  ) {
    const fn = (v as { toMillis?: unknown }).toMillis;
    if (typeof fn === "function") {
      try {
        const n = (fn as () => number)();
        return typeof n === "number" ? n : 0;
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

// ✅ createdAt（Firestore Timestamp）の seconds/nanoseconds まで使って安定ソートする
function resolveCreatedAtSortKey(msg: Msg): { sec: number; nano: number } {
  // まずは createdAtMs があれば最優先（Renova側で入ってる場合がある）
  if (typeof msg.createdAtMs === "number" && Number.isFinite(msg.createdAtMs)) {
    const ms = msg.createdAtMs;
    const sec = Math.floor(ms / 1000);
    const nano = (ms - sec * 1000) * 1_000_000;
    return { sec, nano };
  }

  const v = msg.createdAt;

  // Firestore Timestamp: { seconds, nanoseconds }
  if (
    typeof v === "object" &&
    v !== null &&
    "seconds" in (v as Record<string, unknown>) &&
    "nanoseconds" in (v as Record<string, unknown>)
  ) {
    const secRaw = (v as { seconds?: unknown }).seconds;
    const nanoRaw = (v as { nanoseconds?: unknown }).nanoseconds;
    const sec =
      typeof secRaw === "number" && Number.isFinite(secRaw) ? secRaw : 0;
    const nano =
      typeof nanoRaw === "number" && Number.isFinite(nanoRaw) ? nanoRaw : 0;
    return { sec, nano };
  }

  // Timestamp.toMillis() がある場合
  if (
    typeof v === "object" &&
    v !== null &&
    "toMillis" in (v as Record<string, unknown>)
  ) {
    const fn = (v as { toMillis?: unknown }).toMillis;
    if (typeof fn === "function") {
      try {
        const ms = (fn as () => number)();
        if (typeof ms === "number" && Number.isFinite(ms)) {
          const sec = Math.floor(ms / 1000);
          const nano = (ms - sec * 1000) * 1_000_000;
          return { sec, nano };
        }
      } catch {
        // noop
      }
    }
  }

  // number / string / Date fallback
  if (typeof v === "number" && Number.isFinite(v)) {
    const sec = Math.floor(v / 1000);
    const nano = (v - sec * 1000) * 1_000_000;
    return { sec, nano };
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) {
      const sec = Math.floor(t / 1000);
      const nano = (t - sec * 1000) * 1_000_000;
      return { sec, nano };
    }
  }
  if (v instanceof Date) {
    const t = v.getTime();
    const sec = Math.floor(t / 1000);
    const nano = (t - sec * 1000) * 1_000_000;
    return { sec, nano };
  }

  return { sec: 0, nano: 0 };
}

function inferMediaTypeFromMime(
  mime: string,
): "image" | "video" | "pdf" | null {
  const m = toNonEmptyString(mime);
  if (!m) return null;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  return null;
}

function inferMediaTypeFromFileName(
  name: string,
): "image" | "video" | "pdf" | null {
  const n = toNonEmptyString(name).toLowerCase();
  if (!n) return null;
  if (n.endsWith(".pdf")) return "pdf";
  if (
    n.endsWith(".png") ||
    n.endsWith(".jpg") ||
    n.endsWith(".jpeg") ||
    n.endsWith(".webp") ||
    n.endsWith(".gif")
  )
    return "image";
  if (
    n.endsWith(".mp4") ||
    n.endsWith(".mov") ||
    n.endsWith(".webm") ||
    n.endsWith(".m4v")
  )
    return "video";
  return null;
}

async function uploadAttachment(args: {
  file: File;
  projectId: string;
  roomId: string;
}): Promise<{
  mediaUrl: string;
  mediaType: "image" | "video" | "pdf";
  fileName: string;
  fileUrl: string;
  fileType: string;
}> {
  const f = args.file;

  const isImage = f.type.startsWith("image/");
  const isVideo = f.type.startsWith("video/");
  const isPdf =
    f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"); // ✅ mime空でもpdf扱い

  if (!isImage && !isVideo && !isPdf) {
    throw new Error("UNSUPPORTED_FILE");
  }

  const ext = toNonEmptyString(f.name.split(".").pop());
  const safeName = `${Date.now()}_${Math.random().toString(16).slice(2)}${
    ext ? "." + ext : ""
  }`;

  const path = `projects/${args.projectId}/dm/${args.roomId}/${safeName}`;
  const r = storageRef(storage, path);

  await uploadBytes(r, f, {
    contentType: f.type || "application/octet-stream",
  });
  const url = await getDownloadURL(r);

  const mediaType: "image" | "video" | "pdf" = isImage
    ? "image"
    : isVideo
      ? "video"
      : "pdf";

  return {
    mediaUrl: url,
    mediaType,
    fileName: f.name,
    fileUrl: url,
    fileType: f.type || "application/octet-stream",
  };
}

function normalizeMedia(msg: Msg): {
  url: string;
  kind: "image" | "video" | "pdf" | "link" | null;
  fileName: string;
} {
  const fileName = toNonEmptyString(msg.fileName) || "attachment";

  // 1) 新形式優先
  const mediaUrl = toNonEmptyString(msg.mediaUrl);
  if (mediaUrl) {
    const direct = msg.mediaType ?? null;
    if (direct === "image" || direct === "video" || direct === "pdf") {
      return { url: mediaUrl, kind: direct, fileName };
    }

    // mediaType が null/壊れてる場合：mimeや拡張子で推測
    const byMime = inferMediaTypeFromMime(toNonEmptyString(msg.fileType));
    const byExt = inferMediaTypeFromFileName(fileName);
    const inferred = byMime ?? byExt;

    return { url: mediaUrl, kind: inferred ?? "link", fileName };
  }

  // 2) 旧形式互換
  const fileUrl = toNonEmptyString(msg.fileUrl);
  if (fileUrl) {
    const byMime = inferMediaTypeFromMime(toNonEmptyString(msg.fileType));
    const byExt = inferMediaTypeFromFileName(fileName);
    const inferred = byMime ?? byExt;

    return { url: fileUrl, kind: inferred ?? "link", fileName };
  }

  return { url: "", kind: null, fileName: "" };
}

/** -----------------------------
 * Page
 * ----------------------------*/
export default function DmPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectIdFromQuery = searchParams.get("projectId");

  const params = useParams<{ peerUid: string }>();
  const peerUid = toNonEmptyString(params?.peerUid);

  const session = useMemo(
    () => (typeof window === "undefined" ? null : loadCraftsmanSession()),
    [],
  );

  const projectId =
    toNonEmptyString(projectIdFromQuery) ||
    toNonEmptyString(session?.projectId);

  const [loading, setLoading] = useState(true);
  const [meUid, setMeUid] = useState<string>("");
  const [meName, setMeName] = useState<string>("");

  const [peer, setPeer] = useState<Member | null>(null);

  const [errorText, setErrorText] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<
    Array<{ id: string; roomId: string; docId: string; data: Msg }>
  >([]);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);

  const roomId = useMemo(() => {
    if (!meUid || !peerUid) return "";
    return dmRoomId(meUid, peerUid); // canonical（sort）
  }, [meUid, peerUid]);

  const legacyRoomId = useMemo(() => {
    if (!meUid || !peerUid) return "";
    return `${meUid}__${peerUid}`; // legacy（no sort）
  }, [meUid, peerUid]);

  const legacyRoomIdReverse = useMemo(() => {
    if (!meUid || !peerUid) return "";
    return `${peerUid}__${meUid}`; // legacy reverse
  }, [meUid, peerUid]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 160);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, []);

  // route guard
  useEffect(() => {
    if (!projectId) router.replace("/menu");
  }, [projectId, router]);

  // auth + my profile
  useEffect(() => {
    let mounted = true;

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          router.replace("/login");
          return;
        }
        if (!mounted) return;

        setMeUid(u.uid);

        const mySnap = await getDoc(doc(db, "craftsmen", u.uid));
        const myData = mySnap.exists()
          ? (mySnap.data() as { name?: unknown })
          : null;

        const name =
          (myData ? toNonEmptyString(myData.name) : "") ||
          toNonEmptyString(u.displayName) ||
          "職人";
        setMeName(name);

        setLoading(false);
      } catch (e) {
        console.log("dm auth/profile error:", e);
        if (!mounted) return;
        setErrorText("ログイン情報の取得に失敗しました。");
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [router]);

  // peer profile
  useEffect(() => {
    if (!projectId || !peerUid) return;

    let mounted = true;

    (async () => {
      try {
        const snap = await getDoc(
          doc(db, "projects", projectId, "members", peerUid),
        );
        if (!mounted) return;
        setPeer(snap.exists() ? (snap.data() as Member) : null);
      } catch (e) {
        console.log("peer load error:", e);
        if (!mounted) return;
        setPeer(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [projectId, peerUid]);

  // subscribe messages（canonical + legacy 3本を統合）
  const subscribeKey = useMemo(() => {
    // ✅ useEffect依存配列の「サイズ固定」用のキー
    return [projectId, roomId, legacyRoomId, legacyRoomIdReverse].join("|");
  }, [projectId, roomId, legacyRoomId, legacyRoomIdReverse]);

  useEffect(() => {
    if (!projectId || !roomId) return;

    setErrorText(null);

    const byRoom = new Map<
      string,
      Array<{ id: string; roomId: string; docId: string; data: Msg }>
    >();

    const applyMerged = () => {
      const merged: Array<{
        id: string;
        roomId: string;
        docId: string;
        data: Msg;
      }> = [];
      byRoom.forEach((arr) => merged.push(...arr));

      merged.sort((a, b) => {
        const ka = resolveCreatedAtSortKey(a.data);
        const kb = resolveCreatedAtSortKey(b.data);

        // ✅ 古いものが上（昇順）
        if (ka.sec !== kb.sec) return ka.sec - kb.sec;
        if (ka.nano !== kb.nano) return ka.nano - kb.nano;

        // 完全に同時刻の場合は id で安定化（room混在でも再現性を保つ）
        return a.id.localeCompare(b.id);
      });

      setMsgs(merged);
    };

    const subOne = (rid: string) => {
      const colRef = collection(
        db,
        "projects",
        projectId,
        "dmRooms",
        rid,
        "messages",
      );
      const qy = query(colRef, orderBy("createdAt", "asc"), limit(300));

      return onSnapshot(
        qy,
        async (snap) => {
          const rows: Array<{
            id: string;
            roomId: string;
            docId: string;
            data: Msg;
          }> = [];
          const markReadTasks: Promise<void>[] = [];

          snap.forEach((d) => {
            const mapped = mapMsg(rid, d);
            rows.push(mapped);

            const senderUid = toNonEmptyString(mapped.data.senderUid);
            const readBy = Array.isArray(mapped.data.readBy)
              ? mapped.data.readBy
              : [];
            const alreadyRead = readBy.includes(meUid);

            if (meUid && senderUid && senderUid !== meUid && !alreadyRead) {
              markReadTasks.push(
                updateDoc(
                  doc(
                    db,
                    "projects",
                    projectId,
                    "dmRooms",
                    rid,
                    "messages",
                    d.id,
                  ),
                  {
                    readBy: arrayUnion(meUid),
                  },
                ).catch((err) => {
                  console.log("mark read error:", err);
                }) as Promise<void>,
              );
            }
          });

          if (markReadTasks.length > 0) {
            await Promise.all(markReadTasks);
          }

          byRoom.set(rid, rows);
          applyMerged();
        },
        (err) => {
          console.log("dm onSnapshot error:", err);
          setErrorText("DMの取得に失敗しました。");
        },
      );
    };

    const unsubs: Array<() => void> = [];

    // canonical
    unsubs.push(subOne(roomId));

    // legacy me__peer
    if (legacyRoomId && legacyRoomId !== roomId)
      unsubs.push(subOne(legacyRoomId));

    // legacy peer__me
    if (
      legacyRoomIdReverse &&
      legacyRoomIdReverse !== roomId &&
      legacyRoomIdReverse !== legacyRoomId
    ) {
      unsubs.push(subOne(legacyRoomIdReverse));
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [subscribeKey, projectId, roomId, legacyRoomId, legacyRoomIdReverse]);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  // scroll follow
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const threshold = 40;
    stickToBottomRef.current =
      el.scrollHeight - (el.scrollTop + el.clientHeight) < threshold;
  }

  async function send() {
    if (!projectId || !roomId) return;

    const t = toNonEmptyString(text);
    const hasFile = !!file;
    if (!t && !hasFile) return;

    try {
      setSending(true);
      setErrorText(null);

      const colRef = collection(
        db,
        "projects",
        projectId,
        "dmRooms",
        roomId,
        "messages",
      );

      let media: {
        mediaUrl: string;
        mediaType: "image" | "video" | "pdf";
        fileName: string;
        fileUrl: string;
        fileType: string;
      } | null = null;

      if (file) {
        media = await uploadAttachment({ file, projectId, roomId });
      }

      const payload: Msg = {
        text: t || "",
        senderUid: meUid,
        senderName: meName,
        toUid: peerUid,
        readBy: [meUid],
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        ...(media ? media : {}),
      };

      await addDoc(colRef, payload);

      setText("");
      setFile(null);
      stickToBottomRef.current = true;

      requestAnimationFrame(() => {
        resizeTextarea();
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("dm send error:", e);

      if (msg === "UNSUPPORTED_FILE") {
        setErrorText("画像/動画/PDF以外は添付できません。");
        return;
      }

      setErrorText("送信に失敗しました。通信状況をご確認ください。");
    } finally {
      setSending(false);
    }
  }

  if (loading) return null;
  if (!peerUid) return null;
  if (!projectId) return null;

  const peerName = toNonEmptyString(peer?.name) || "相手";

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      {/* header */}
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              DM：{peerName}
            </div>
            <div className="truncate text-xs font-bold text-gray-500 dark:text-gray-400">
              現場：{session?.projectName || "（名称未設定）"}
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              router.push(
                `/managers?projectId=${encodeURIComponent(projectId)}`,
              )
            }
            className="shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                       dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            戻る
          </button>
        </div>
      </div>

      {/* body */}
      <div className="mx-auto w-full max-w-2xl px-3 pt-3 pb-[96px]">
        {errorText && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">{errorText}</p>
          </div>
        )}

        <div className="rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="h-[calc(100dvh-230px)] overflow-y-auto px-3 py-3 pb-28"
          >
            {msgs.length === 0 ? (
              <div className="rounded-xl border bg-white p-4 text-sm font-bold text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                まだメッセージがありません。
              </div>
            ) : (
              <div className="grid gap-2">
                {msgs.map((m) => {
                  const mine = m.data.senderUid === meUid;
                  const sender = toNonEmptyString(m.data.senderName) || "不明";
                  const body = toNonEmptyString(m.data.text);

                  const media = normalizeMedia(m.data);

                  return (
                    <div
                      key={m.id}
                      className={
                        mine ? "flex justify-end" : "flex justify-start"
                      }
                    >
                      <div className="max-w-[90%]">
                        <div
                          className={[
                            "rounded-2xl border px-3 py-2",
                            mine
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800",
                          ].join(" ")}
                        >
                          {!mine && (
                            <div className="mb-1 text-[11px] font-extrabold opacity-80">
                              {sender}
                            </div>
                          )}

                          {/* ✅ 添付（Renova / craftsman 両対応） */}
                          {media.url && media.kind === "image" && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={media.url}
                              alt={media.fileName}
                              className="mb-2 max-h-64 max-w-full rounded-xl"
                              loading="lazy"
                            />
                          )}

                          {media.url && media.kind === "video" && (
                            <video
                              src={media.url}
                              controls
                              className="mb-2 max-h-64 max-w-full rounded-xl"
                            />
                          )}

                          {media.url &&
                            (media.kind === "pdf" || media.kind === "link") && (
                              <a
                                href={media.url}
                                target="_blank"
                                rel="noreferrer"
                                className={[
                                  "mb-2 inline-flex w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-extrabold text-gray-900 hover:bg-gray-50",
                                  "dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900",
                                  mine ? "" : "",
                                ].join(" ")}
                              >
                                <span className="truncate">
                                  {media.kind === "pdf" ? "📄" : "📎"}{" "}
                                  {media.fileName || "添付ファイル"}
                                </span>
                                <span className="shrink-0">開く</span>
                              </a>
                            )}

                          {body && (
                            <div className="whitespace-pre-wrap text-sm font-bold leading-relaxed">
                              {body}
                            </div>
                          )}
                        </div>

                        {mine && (
                          <div className="mt-1 px-1 text-right text-[11px] font-extrabold text-gray-500 dark:text-gray-400">
                            {(Array.isArray(m.data.readBy)
                              ? m.data.readBy
                              : []
                            ).includes(peerUid)
                              ? "既読"
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

          {/* composer */}
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white/95 px-3 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95">
            {sending && (
              <div className="mx-auto mb-2 flex w-full max-w-2xl items-center gap-2 text-xs font-extrabold text-gray-600 dark:text-gray-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                送信中...
              </div>
            )}

            {file && (
              <div className="mx-auto mb-2 flex w-full max-w-2xl items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-bold dark:border-gray-800">
                <div className="truncate">添付：{file.name}</div>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="rounded-lg border px-2 py-1 text-xs font-extrabold hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                >
                  外す
                </button>
              </div>
            )}

            <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
              <label className="shrink-0 inline-flex cursor-pointer items-center justify-center rounded-xl border bg-white p-2 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900">
                <Paperclip className="h-5 w-5" />
                <input
                  type="file"
                  accept="image/*,video/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setFile(f);
                    e.currentTarget.value = "";
                  }}
                  disabled={sending}
                />
              </label>

              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onInput={resizeTextarea}
                placeholder="メッセージを入力..."
                rows={1}
                className="min-h-[44px] max-h-[160px] w-full resize-none overflow-hidden rounded-xl border px-3 py-2 font-bold text-gray-900
                           focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                style={{ fontSize: 16 }}
                disabled={sending}
              />

              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || (!toNonEmptyString(text) && !file)}
                className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
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

            <div className="mx-auto mt-2 w-full max-w-2xl text-[11px] font-bold text-gray-500 dark:text-gray-400">
              ※ 画像/動画/PDFのみ添付可
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
