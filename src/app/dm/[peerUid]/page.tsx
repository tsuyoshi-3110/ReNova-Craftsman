"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";

import { auth, db, storage } from "@/lib/firebaseClient";
import { loadCraftsmanSession } from "@/lib/craftsmanSession";

type Msg = {
  text?: string;
  senderUid?: string;
  senderName?: string;
  createdAt?: unknown;

  fileUrl?: string;
  fileName?: string;
  fileType?: string; // mime
};

type Member = {
  uid?: string;
  role?: string;
  name?: string;
  company?: string;
  phone?: string;
};

function toNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function mapMsg(d: QueryDocumentSnapshot<DocumentData>): { id: string; data: Msg } {
  return { id: d.id, data: d.data() as Msg };
}

function dmRoomId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

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
  const [msgs, setMsgs] = useState<Array<{ id: string; data: Msg }>>([]);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const roomId = useMemo(() => {
    if (!meUid || !peerUid) return "";
    return dmRoomId(meUid, peerUid);
  }, [meUid, peerUid]);

  useEffect(() => {
    if (!projectId) {
      router.replace("/menu");
    }
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

        // craftsmen doc から名前
        const mySnap = await getDoc(doc(db, "craftsmen", u.uid));
        const myData = mySnap.exists() ? (mySnap.data() as { name?: unknown }) : null;

        const myName = myData ? toNonEmptyString(myData.name) : "";
        setMeName(myName || toNonEmptyString(u.displayName) || "職人");

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

  // peer profile (projects/{projectId}/members/{peerUid})
  useEffect(() => {
    if (!projectId || !peerUid) return;

    let mounted = true;

    (async () => {
      try {
        const snap = await getDoc(doc(db, "projects", projectId, "members", peerUid));
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

  // subscribe messages
  useEffect(() => {
    if (!projectId || !roomId) return;

    setErrorText(null);

    const colRef = collection(db, "projects", projectId, "dmRooms", roomId, "messages");
    const qy = query(colRef, orderBy("createdAt", "asc"), limit(300));

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: Array<{ id: string; data: Msg }> = [];
        snap.forEach((d) => rows.push(mapMsg(d)));
        setMsgs(rows);
      },
      (err) => {
        console.log("dm onSnapshot error:", err);
        setErrorText("DMの取得に失敗しました。");
      },
    );

    return () => unsub();
  }, [projectId, roomId]);

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

  async function sendText() {
    if (!projectId || !roomId) return;
    const t = toNonEmptyString(text);
    if (!t) return;

    try {
      setSending(true);

      const colRef = collection(db, "projects", projectId, "dmRooms", roomId, "messages");
      await addDoc(colRef, {
        text: t,
        senderUid: meUid,
        senderName: meName,
        createdAt: serverTimestamp(),
      });

      setText("");
      stickToBottomRef.current = true;
    } catch (e) {
      console.log("send text error:", e);
      setErrorText("送信に失敗しました。");
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    if (!projectId || !roomId) return;

    try {
      setSending(true);
      setUploadingName(file.name);
      setErrorText(null);

      const key = `${Date.now()}_${file.name}`.replace(/\s+/g, "_");
      const path = `projects/${projectId}/dmUploads/${roomId}/${key}`;
      const sref = storageRef(storage, path);

      await uploadBytes(sref, file);
      const url = await getDownloadURL(sref);

      const colRef = collection(db, "projects", projectId, "dmRooms", roomId, "messages");
      await addDoc(colRef, {
        senderUid: meUid,
        senderName: meName,
        createdAt: serverTimestamp(),
        fileUrl: url,
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
      });

      stickToBottomRef.current = true;
    } catch (e) {
      console.log("send file error:", e);
      setErrorText("ファイル送信に失敗しました。");
    } finally {
      setUploadingName(null);
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
            onClick={() => router.push(`/managers?projectId=${encodeURIComponent(projectId)}`)}
            className="shrink-0 rounded-xl border bg-white px-3 py-2 text-sm font-extrabold text-gray-900 hover:bg-gray-50
                       dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900"
          >
            戻る
          </button>
        </div>
      </div>

      {/* body */}
      <div className="mx-auto w-full max-w-2xl px-3 py-3">
        {errorText && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">{errorText}</p>
          </div>
        )}

        <div className="rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="h-[calc(100dvh-230px)] overflow-y-auto px-3 py-3"
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
                  const fileUrl = toNonEmptyString(m.data.fileUrl);
                  const fileName = toNonEmptyString(m.data.fileName) || "file";
                  const fileType = toNonEmptyString(m.data.fileType);

                  return (
                    <div key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                      <div
                        className={[
                          "max-w-[90%] rounded-2xl border px-3 py-2",
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

                        {body && (
                          <div className="whitespace-pre-wrap text-sm font-bold leading-relaxed">
                            {body}
                          </div>
                        )}

                        {fileUrl && (
                          <div className="mt-2">
                            {fileType.startsWith("image/") ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={fileUrl} alt={fileName} className="max-h-64 rounded-xl" />
                            ) : (
                              <a
                                href={fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className={mine ? "text-white underline" : "text-blue-600 underline"}
                              >
                                {fileName}
                              </a>
                            )}
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
          <div className="border-t bg-white px-3 py-3 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-end gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="メッセージを入力..."
                rows={2}
                className="w-full resize-none rounded-xl border px-3 py-2 font-bold text-gray-900
                           focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                style={{ fontSize: 16 }}
                disabled={sending}
              />

              <div className="flex flex-col items-end gap-2">
                <label className="cursor-pointer rounded-xl border bg-white px-3 py-2 text-xs font-extrabold text-gray-900 hover:bg-gray-50
                                  dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-gray-900">
                  添付
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*,video/*,application/pdf"
                    disabled={sending}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void sendFile(f);
                    }}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void sendText()}
                  disabled={sending || !toNonEmptyString(text)}
                  className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
                >
                  送信
                </button>
              </div>
            </div>

            {/* ✅ 送信中インジケータ */}
            {sending && (
              <div className="mt-2 flex items-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-300">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent dark:border-gray-700 dark:border-t-transparent" />
                送信中...
                {uploadingName ? `（${uploadingName}）` : ""}
              </div>
            )}

            <div className="mt-2 text-[11px] font-bold text-gray-500 dark:text-gray-400">
              ※ 添付は 画像 / 動画 / PDF に対応
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
