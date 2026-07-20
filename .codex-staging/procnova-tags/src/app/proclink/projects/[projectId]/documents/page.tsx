"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { type User } from "firebase/auth";
import {
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import {
  ArrowLeft,
  Check,
  CheckSquare,
  Download,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderArchive,
  FolderInput,
  FolderPlus,
  Link2,
  Loader2,
  MessageCircle,
  Pencil,
  Reply,
  Search,
  Send,
  Share2,
  Tag,
  Trash2,
  UploadCloud,
  X,
  ZoomIn,
} from "lucide-react";
import { saveAs } from "file-saver";

import { db, storage } from "@/lib/firebaseClient";
import { useProjectRole } from "@/app/proclink/projects/_hooks/useProjectRole";

function safeDecode(v: string | null): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v ?? "";
  }
}

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
        ? (v as { nanoseconds: number }).nanoseconds
        : 0;
    return seconds * 1000 + Math.floor(nanoseconds / 1000000);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return 0;
}

type DocFile = {
  id: string;
  name: string;
  storagePath: string;
  downloadUrl: string;
  fileType: string;
  fileSize: number;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: { toDate(): Date } | null;
  // フォルダ分類（null/未設定 = トップ直下）
  folderId?: string | null;
  // コメント件数（バッジ表示用。コメント追加/削除時に増減）
  commentCount?: number;
  // 検索・分類用タグ（最大12件）
  tags?: string[];
};

// 共有シートに渡す画像 File を作る（拡張子がないと共有先アプリで扱えないことがあるため補完）
function buildShareImageFile(blob: Blob, d: DocFile): File {
  const type = blob.type || d.fileType || "image/jpeg";
  let name = d.name.trim() || "image";
  if (!/\.[a-z0-9]{1,6}$/i.test(name)) {
    if (type.includes("png")) name += ".png";
    else if (type.includes("webp")) name += ".webp";
    else if (type.includes("gif")) name += ".gif";
    else name += ".jpg";
  }
  return new File([blob], name, { type });
}

type DocComment = {
  id: string;
  text: string;
  authorUid: string;
  authorName: string;
  parentId: string | null; // null=トップレベル、値あり=その親への返信
  createdAt: { toDate(): Date } | null;
};

type DocCommentMeta = {
  authorUid: string;
  createdAt: unknown;
};

type DocFolder = {
  id: string;
  name: string;
  createdBy?: string;
  createdByName?: string;
  createdAt: { toDate(): Date } | null;
};

function formatContributorName(name?: string | null): string {
  const value = name?.trim();
  return value ? value : "不明";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_TAGS_PER_DOCUMENT = 12;
const MAX_TAG_LENGTH = 24;
const STANDARD_DOCUMENT_TAGS = [
  "見積",
  "契約",
  "発注",
  "請求",
  "図面",
  "報告書",
  "申請・許可",
  "写真",
  "明細書",
  "その他",
] as const;

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalizedTag = item.trim() === "工事明細書" ? "明細書" : item.trim();
    const tag = normalizedTag.slice(0, MAX_TAG_LENGTH);
    const key = tag.toLocaleLowerCase("ja-JP");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_DOCUMENT) break;
  }
  return result;
}

function matchesDocumentSearch(d: DocFile, queryText: string): boolean {
  const queryValue = queryText.trim().toLocaleLowerCase("ja-JP");
  if (!queryValue) return true;
  return [d.name, d.uploadedByName, ...normalizeTags(d.tags)]
    .join(" ")
    .toLocaleLowerCase("ja-JP")
    .includes(queryValue);
}

const STANDARD_FILE_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_FILE_MAX_BYTES = 200 * 1024 * 1024;

function isVideoFileType(fileType: string): boolean {
  return fileType.startsWith("video/");
}

function isVideoFile(file: File): boolean {
  if (isVideoFileType(file.type)) return true;
  return /\.(mp4|mov|webm)$/i.test(file.name);
}

function uploadLimitForFile(file: File): number {
  return isVideoFile(file) ? VIDEO_FILE_MAX_BYTES : STANDARD_FILE_MAX_BYTES;
}

function uploadLimitLabelForFile(file: File): string {
  return isVideoFile(file) ? "200MB" : "50MB";
}

function inferUploadContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.mp4$/i.test(file.name)) return "video/mp4";
  if (/\.mov$/i.test(file.name)) return "video/quicktime";
  if (/\.webm$/i.test(file.name)) return "video/webm";
  return "application/octet-stream";
}

function fileColor(fileType: string): string {
  if (fileType.includes("pdf")) return "bg-red-100 dark:bg-red-950/40";
  if (isVideoFileType(fileType)) return "bg-sky-100 dark:bg-sky-950/40";
  if (
    fileType.includes("spreadsheet") ||
    fileType.includes("excel") ||
    fileType.includes("csv")
  )
    return "bg-green-100 dark:bg-green-950/40";
  if (fileType.includes("word") || fileType.includes("document"))
    return "bg-blue-100 dark:bg-blue-950/40";
  if (fileType.includes("presentation") || fileType.includes("powerpoint"))
    return "bg-orange-100 dark:bg-orange-950/40";
  if (fileType.startsWith("image/"))
    return "bg-purple-100 dark:bg-purple-950/40";
  return "bg-gray-100 dark:bg-gray-800";
}

function FileTypeIcon({
  fileType,
  className,
}: {
  fileType: string;
  className?: string;
}) {
  if (fileType.includes("pdf")) return <FileText className={className} />;
  if (isVideoFileType(fileType)) return <FileVideo className={className} />;
  if (
    fileType.includes("spreadsheet") ||
    fileType.includes("excel") ||
    fileType.includes("csv")
  )
    return <FileSpreadsheet className={className} />;
  if (fileType.includes("word") || fileType.includes("document"))
    return <FileType className={className} />;
  if (fileType.startsWith("image/")) return <FileImage className={className} />;
  return <FolderArchive className={className} />;
}

const ACCEPTED =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.mp4,.mov,.webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,image/*,video/mp4,video/quicktime,video/webm";

const FOLDER_DROP_PREFIX = "folder-drop:";
const TOP_DROP_ID = "folder-drop:top";

function folderDropId(folderId: string): string {
  return `${FOLDER_DROP_PREFIX}${folderId}`;
}

function folderIdFromDropId(dropId: string): string | null | undefined {
  if (dropId === TOP_DROP_ID) return null;
  if (!dropId.startsWith(FOLDER_DROP_PREFIX)) return undefined;
  return dropId.slice(FOLDER_DROP_PREFIX.length);
}

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (
    success: (file: File) => void,
    error?: (error: DOMException) => void,
  ) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

type DroppedFolder = {
  name: string;
  files: File[];
};

function entryFile(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readDirectoryEntries(
  entry: FileSystemDirectoryEntryLike,
): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const result: FileSystemEntryLike[] = [];

  while (true) {
    const batch = await new Promise<FileSystemEntryLike[]>(
      (resolve, reject) => {
        reader.readEntries(resolve, reject);
      },
    );
    if (batch.length === 0) break;
    result.push(...batch);
  }

  return result;
}

async function collectFilesFromEntry(
  entry: FileSystemEntryLike,
): Promise<File[]> {
  if (entry.isFile) {
    return [await entryFile(entry as FileSystemFileEntryLike)];
  }

  if (!entry.isDirectory) return [];

  const children = await readDirectoryEntries(
    entry as FileSystemDirectoryEntryLike,
  );
  const nested = await Promise.all(
    children.map((child) => collectFilesFromEntry(child)),
  );
  return nested.flat();
}

async function getDroppedFolders(
  items: DataTransferItemList,
): Promise<DroppedFolder[]> {
  const folders: DroppedFolder[] = [];

  for (const item of Array.from(items) as DataTransferItemWithEntry[]) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry?.isDirectory) continue;
    folders.push({
      name: entry.name,
      files: await collectFilesFromEntry(entry),
    });
  }

  return folders;
}

// ── プレビューモーダル ────────────────────────────────────────
function formatCommentTime(ts: { toDate(): Date } | null): string {
  if (!ts) return "送信中…";
  const dt = ts.toDate();
  const now = new Date();
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  if (dt.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${hh}:${mm}`;
}

// ── ファイルごとのコメント（コメント＋返信のチャット） ──────────
function CommentsSection({
  projectId,
  docId,
  me,
  isOwner,
}: {
  projectId: string;
  docId: string;
  me: User | null;
  isOwner: boolean;
}) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (!projectId || !docId) return;
    setLoading(true);
    const q = query(
      collection(db, "projects", projectId, "documents", docId, "comments"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setComments(
          snap.docs.map((s) => ({
            id: s.id,
            ...(s.data() as Omit<DocComment, "id">),
          })),
        );
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [projectId, docId]);

  const topLevel = comments.filter((c) => !c.parentId);
  const repliesByParent = useMemo(() => {
    const m = new Map<string, DocComment[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const arr = m.get(c.parentId) ?? [];
      arr.push(c);
      m.set(c.parentId, arr);
    }
    return m;
  }, [comments]);

  const post = useCallback(
    async (body: string, parentId: string | null) => {
      const value = body.trim();
      if (!value || !me || !projectId || !docId || posting) return;
      setPosting(true);
      try {
        const batch = writeBatch(db);
        const ref = doc(
          collection(db, "projects", projectId, "documents", docId, "comments"),
        );
        batch.set(ref, {
          text: value,
          authorUid: me.uid,
          authorName: me.displayName ?? me.email ?? "不明",
          parentId: parentId ?? null,
          createdAt: serverTimestamp(),
        });
        batch.update(doc(db, "projects", projectId, "documents", docId), {
          commentCount: increment(1),
        });
        await batch.commit();
        if (parentId) {
          setReplyText("");
          setReplyTo(null);
        } else {
          setText("");
        }
      } catch {
        alert("コメントの送信に失敗しました。");
      } finally {
        setPosting(false);
      }
    },
    [docId, me, posting, projectId],
  );

  const remove = useCallback(
    async (c: DocComment) => {
      if (!projectId || !docId) return;
      if (!confirm("このコメントを削除しますか？")) return;
      try {
        const batch = writeBatch(db);
        let removed = 0;
        if (!c.parentId) {
          // トップレベル削除時は返信も一緒に削除
          for (const r of repliesByParent.get(c.id) ?? []) {
            batch.delete(
              doc(
                db,
                "projects",
                projectId,
                "documents",
                docId,
                "comments",
                r.id,
              ),
            );
            removed++;
          }
        }
        batch.delete(
          doc(db, "projects", projectId, "documents", docId, "comments", c.id),
        );
        removed++;
        batch.update(doc(db, "projects", projectId, "documents", docId), {
          commentCount: increment(-removed),
        });
        await batch.commit();
      } catch {
        alert("コメントの削除に失敗しました。");
      }
    },
    [docId, projectId, repliesByParent],
  );

  const canDelete = (c: DocComment) =>
    !!me && (isOwner || c.authorUid === me.uid);

  const renderMeta = (c: DocComment) => (
    <div className="flex items-center gap-2">
      <span className="text-xs font-extrabold text-gray-900 dark:text-gray-100">
        {c.authorName}
      </span>
      <span className="text-[10px] text-gray-400">
        {formatCommentTime(c.createdAt)}
      </span>
      {canDelete(c) && (
        <button
          type="button"
          onClick={() => void remove(c)}
          className="ml-auto text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
          title="削除"
          aria-label="コメントを削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-sm font-extrabold text-gray-800 dark:text-gray-100">
        <MessageCircle className="h-4 w-4" />
        コメント
        {topLevel.length > 0 && (
          <span className="text-gray-400">（{topLevel.length}）</span>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      ) : topLevel.length === 0 ? (
        <p className="rounded-xl bg-gray-50 px-3 py-4 text-center text-xs text-gray-400 dark:bg-gray-950/60">
          まだコメントはありません
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {topLevel.map((c) => (
            <div
              key={c.id}
              className="rounded-2xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
            >
              {renderMeta(c)}
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200">
                {c.text}
              </p>

              {/* 返信一覧 */}
              {(repliesByParent.get(c.id) ?? []).length > 0 && (
                <div className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3 dark:border-gray-800">
                  {(repliesByParent.get(c.id) ?? []).map((r) => (
                    <div key={r.id}>
                      {renderMeta(r)}
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">
                        {r.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* 返信入力 */}
              {me &&
                (replyTo === c.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={replyText}
                      autoFocus
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          void post(replyText, c.id);
                        }
                      }}
                      placeholder="返信を入力"
                      className="min-h-9 flex-1 rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      disabled={posting || !replyText.trim()}
                      onClick={() => void post(replyText, c.id)}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo(null);
                        setReplyText("");
                      }}
                      className="shrink-0 text-xs font-bold text-gray-400 hover:text-gray-600"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      title="返信する"
                      aria-label="返信する"
                      onClick={() => {
                        setReplyTo(c.id);
                        setReplyText("");
                      }}
                      className="grid h-8 w-8 place-items-center rounded-full text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40"
                    >
                      <Reply className="h-4 w-4" />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {/* 新規コメント入力 */}
      {me ? (
        <div className="flex items-center gap-2 pt-1">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                void post(text, null);
              }
            }}
            placeholder="コメントを入力"
            className="min-h-10 flex-1 rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          <button
            type="button"
            disabled={posting || !text.trim()}
            onClick={() => void post(text, null)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          コメントするにはログインが必要です
        </p>
      )}
    </div>
  );
}

function DocPreviewModal({
  doc: d,
  projectId,
  me,
  isOwner,
  onClose,
  onDownload,
  onShare,
}: {
  doc: DocFile;
  projectId: string;
  me: User | null;
  isOwner: boolean;
  onClose: () => void;
  onDownload: (d: DocFile) => void;
  onShare?: (d: DocFile) => void;
}) {
  const isImage = d.fileType.startsWith("image/");
  const isPdf = d.fileType.includes("pdf");
  const isVideo = isVideoFileType(d.fileType);

  // ESC で閉じる
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl dark:bg-gray-900 sm:rounded-3xl"
        style={{ maxHeight: "92dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              {d.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {formatFileSize(d.fileSize)}　{d.uploadedByName}
            </p>
          </div>
          {onShare && (
            <button
              type="button"
              title="写真に保存（共有）"
              onClick={() => onShare(d)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
            >
              <Share2 className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            title="ダウンロード"
            onClick={() => onDownload(d)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="閉じる"
            onClick={onClose}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 本体：プレビュー（高さ制限）＋ コメント（スクロール） */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* プレビュー */}
          <div
            className="flex shrink-0 items-center justify-center overflow-auto bg-gray-50 dark:bg-gray-950"
            style={{ maxHeight: "45dvh" }}
          >
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={d.downloadUrl}
                alt={d.name}
                className="max-h-full max-w-full object-contain"
                style={{ maxHeight: "45dvh" }}
              />
            ) : isVideo ? (
              <video
                src={d.downloadUrl}
                controls
                preload="metadata"
                className="max-h-full max-w-full bg-black"
                style={{ maxHeight: "45dvh" }}
              />
            ) : isPdf ? (
              <iframe
                src={d.downloadUrl}
                className="w-full border-0"
                style={{ height: "45dvh" }}
                title={d.name}
              />
            ) : (
              <div className="flex flex-col items-center gap-5 px-8 py-12">
                <div
                  className={[
                    "grid h-24 w-24 place-items-center rounded-3xl",
                    fileColor(d.fileType),
                  ].join(" ")}
                >
                  <FileTypeIcon
                    fileType={d.fileType}
                    className="h-12 w-12 text-gray-600 dark:text-gray-300"
                  />
                </div>
                <p className="text-center text-sm text-gray-500 dark:text-gray-400">
                  このファイル形式はブラウザでプレビューできません
                </p>
                <button
                  type="button"
                  onClick={() => onDownload(d)}
                  className="inline-flex items-center gap-2 rounded-2xl bg-gray-900 px-6 py-3 text-sm font-extrabold text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900"
                >
                  <Download className="h-4 w-4" />
                  ダウンロード
                </button>
              </div>
            )}
          </div>

          {/* コメント */}
          <div className="border-t border-gray-100 p-4 dark:border-gray-800">
            <CommentsSection
              projectId={projectId}
              docId={d.id}
              me={me}
              isOwner={isOwner}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ソート可能カード ──────────────────────────────────────────
type CardProps = {
  doc: DocFile;
  canManage: boolean;
  unreadCount: number;
  onSelect: (d: DocFile) => void;
  onOpenActions: (d: DocFile) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (d: DocFile) => void;
};

function SortableCard({
  doc: d,
  canManage,
  unreadCount,
  onSelect,
  onOpenActions,
  selectMode,
  selected,
  onToggleSelect,
}: CardProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const longPressStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const touchMovedRef = useRef(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: d.id, disabled: !canManage || selectMode });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const isImage = d.fileType.startsWith("image/");
  const tags = normalizeTags(d.tags);

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const resetLongPress = () => {
    clearLongPressTimer();
    longPressStartPointRef.current = null;
  };

  const startLongPress = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canManage || e.pointerType === "mouse") return;
    resetLongPress();
    longPressedRef.current = false;
    longPressStartPointRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      longPressStartPointRef.current = null;
      onOpenActions(d);
    }, 550);
  };

  const handleLongPressMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const startPoint = longPressStartPointRef.current;
    if (!startPoint) return;
    const dx = Math.abs(e.clientX - startPoint.x);
    const dy = Math.abs(e.clientY - startPoint.y);
    if (dx > 8 || dy > 8) {
      suppressClickRef.current = true;
      resetLongPress();
    }
  };

  const startTouchLongPress = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!canManage) return;
    const touch = e.touches[0];
    if (!touch) return;
    resetLongPress();
    suppressClickRef.current = false;
    touchMovedRef.current = false;
    longPressedRef.current = false;
    longPressStartPointRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      suppressClickRef.current = true;
      longPressStartPointRef.current = null;
      onOpenActions(d);
    }, 550);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const startPoint = longPressStartPointRef.current;
    const touch = e.touches[0];
    if (!startPoint || !touch) return;
    const dx = Math.abs(touch.clientX - startPoint.x);
    const dy = Math.abs(touch.clientY - startPoint.y);
    if (dx > 8 || dy > 8) {
      touchMovedRef.current = true;
      suppressClickRef.current = true;
      resetLongPress();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!canManage) return;
    const wasLongPressed = longPressedRef.current;
    const wasTouchMoved = touchMovedRef.current || suppressClickRef.current;
    resetLongPress();
    touchMovedRef.current = false;
    if (wasTouchMoved) {
      suppressClickRef.current = true;
      return;
    }
    if (wasLongPressed) {
      longPressedRef.current = false;
      suppressClickRef.current = true;
      return;
    }
    e.preventDefault();
    suppressClickRef.current = true;
    onSelect(d);
  };

  const handleSelect = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    onSelect(d);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onContextMenu={(e) => {
        if (!canManage) return;
        e.preventDefault();
        onOpenActions(d);
      }}
      className={[
        "group relative flex aspect-[1/1.08] flex-col overflow-hidden rounded-2xl border",
        "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900",
        "cursor-default",
      ].join(" ")}
    >
      {/* メイン領域（画像 or アイコン）— タップでプレビュー */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden select-none"
        onPointerDown={startLongPress}
        onPointerMove={handleLongPressMove}
        onPointerUp={resetLongPress}
        onPointerCancel={resetLongPress}
        onTouchStart={startTouchLongPress}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={resetLongPress}
        onClick={handleSelect}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
      >
        {/* コメント件数 / 未読数バッジ */}
        {unreadCount > 0 ? (
          <span
            className="pointer-events-none absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm"
            aria-label={`未読 ${unreadCount}`}
          >
            <MessageCircle className="h-3 w-3" />
            {unreadCount}
          </span>
        ) : !!d.commentCount && d.commentCount > 0 ? (
          <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-gray-900/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
            <MessageCircle className="h-3 w-3" />
            {d.commentCount}
          </span>
        ) : null}

        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={d.downloadUrl}
            alt={d.name}
            className="h-full w-full object-cover select-none"
            draggable={false}
          />
        ) : (
          <div
            className={[
              "flex h-full w-full items-center justify-center",
              fileColor(d.fileType),
            ].join(" ")}
          >
            <FileTypeIcon
              fileType={d.fileType}
              className="h-7 w-7 text-gray-600 dark:text-gray-300"
            />
          </div>
        )}
      </div>

      {/* ファイル名・サイズ */}
      <div
        {...(canManage ? { ...attributes, ...listeners } : {})}
        className={[
          "shrink-0 touch-none border-t border-gray-100 px-2 py-1 dark:border-gray-800",
          canManage
            ? "cursor-grab select-none active:cursor-grabbing"
            : "cursor-pointer",
        ].join(" ")}
        style={canManage ? { touchAction: "none" } : undefined}
        onClick={canManage ? undefined : handleSelect}
      >
        <p className="truncate text-[11px] font-bold leading-tight text-gray-900 dark:text-gray-100">
          {d.name}
        </p>
        <p className="text-[9px] leading-tight text-gray-500 dark:text-gray-400">
          {formatFileSize(d.fileSize)}
        </p>
        <p className="truncate text-[9px] leading-tight text-gray-500 dark:text-gray-400">
          追加: {formatContributorName(d.uploadedByName)}
        </p>
        {tags.length > 0 && (
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <span className="max-w-[76%] truncate rounded-full bg-blue-50 px-1.5 py-0.5 text-[8px] font-bold leading-none text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
              #{tags[0]}
            </span>
            {tags.length > 1 && (
              <span className="shrink-0 text-[8px] font-bold text-gray-400">
                +{tags.length - 1}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 選択モード：カード全体タップで選択切り替え */}
      {selectMode && (
        <button
          type="button"
          onClick={() => onToggleSelect(d)}
          aria-pressed={selected}
          aria-label={selected ? `${d.name} の選択を解除` : `${d.name} を選択`}
          className="absolute inset-0 z-20"
        >
          {selected && (
            <span className="absolute inset-0 rounded-2xl bg-blue-500/15 ring-2 ring-inset ring-blue-500" />
          )}
          <span
            className={[
              "absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border-2 shadow-sm",
              selected
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-gray-300 bg-white/90 dark:border-gray-600 dark:bg-gray-900/90",
            ].join(" ")}
          >
            {selected ? <Check className="h-4 w-4" /> : null}
          </span>
        </button>
      )}
    </div>
  );
}

type FolderCardProps = {
  folder: DocFolder;
  count: number;
  canManage: boolean;
  onOpen: (folderId: string) => void;
  onOpenActions: (folder: DocFolder) => void;
};

function FolderCard({
  folder,
  count,
  canManage,
  onOpen,
  onOpenActions,
}: FolderCardProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const longPressStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const touchMovedRef = useRef(false);
  const { isOver, setNodeRef } = useDroppable({
    id: folderDropId(folder.id),
    disabled: !canManage,
  });

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const resetLongPress = () => {
    clearLongPressTimer();
    longPressStartPointRef.current = null;
  };

  const startTouchLongPress = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (!touch) return;
    resetLongPress();
    suppressClickRef.current = false;
    touchMovedRef.current = false;
    longPressedRef.current = false;
    longPressStartPointRef.current = { x: touch.clientX, y: touch.clientY };
    // まとめてダウンロードは全ロール可のため、長押しメニューは誰でも開ける
    longPressTimerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      suppressClickRef.current = true;
      longPressStartPointRef.current = null;
      onOpenActions(folder);
    }, 550);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const startPoint = longPressStartPointRef.current;
    const touch = e.touches[0];
    if (!startPoint || !touch) return;
    const dx = Math.abs(touch.clientX - startPoint.x);
    const dy = Math.abs(touch.clientY - startPoint.y);
    if (dx > 8 || dy > 8) {
      touchMovedRef.current = true;
      suppressClickRef.current = true;
      resetLongPress();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const wasLongPressed = longPressedRef.current;
    const wasTouchMoved = touchMovedRef.current || suppressClickRef.current;
    resetLongPress();
    touchMovedRef.current = false;
    if (wasTouchMoved) {
      suppressClickRef.current = true;
      return;
    }
    if (wasLongPressed) {
      longPressedRef.current = false;
      suppressClickRef.current = true;
      return;
    }
    e.preventDefault();
    suppressClickRef.current = true;
    onOpen(folder.id);
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    onOpen(folder.id);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={handleClick}
      onTouchStart={startTouchLongPress}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={resetLongPress}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenActions(folder);
      }}
      className={[
        "relative flex aspect-[1/1.08] cursor-pointer select-none flex-col overflow-hidden rounded-2xl border bg-white transition-colors dark:bg-gray-900",
        isOver
          ? "border-blue-400 bg-blue-50 ring-2 ring-blue-300 dark:border-blue-500 dark:bg-blue-950/30"
          : "border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/70",
      ].join(" ")}
      style={{
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
      }}
    >
      <div className="flex flex-1 items-center justify-center bg-amber-50 dark:bg-amber-950/20">
        <Folder
          className="h-9 w-9 text-amber-500"
          fill="currentColor"
          fillOpacity={0.2}
        />
      </div>
      <div className="shrink-0 border-t border-gray-100 px-2 py-1 dark:border-gray-800">
        <p className="truncate text-[11px] font-bold leading-tight text-gray-900 dark:text-gray-100">
          {folder.name}
        </p>
        <p className="text-[9px] leading-tight text-gray-500 dark:text-gray-400">
          {count} 件
        </p>
        <p className="truncate text-[9px] leading-tight text-gray-500 dark:text-gray-400">
          追加: {formatContributorName(folder.createdByName)}
        </p>
      </div>
    </div>
  );
}

function FolderActionPanel({
  folder,
  canManage,
  onClose,
  onRename,
  onDelete,
  onDownload,
}: {
  folder: DocFolder;
  canManage: boolean;
  onClose: () => void;
  onRename: (folder: DocFolder) => void;
  onDelete: (folder: DocFolder) => void;
  onDownload: (folder: DocFolder) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="w-full select-none rounded-3xl bg-white p-4 shadow-2xl dark:bg-gray-900 sm:max-w-sm"
        style={{
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">
            <Folder className="h-6 w-6" fill="currentColor" fillOpacity={0.2} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              {folder.name}
            </p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => {
              onDownload(folder);
              onClose();
            }}
            className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <Download className="h-5 w-5 shrink-0" />
            まとめてダウンロード
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onRename(folder);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              <Pencil className="h-5 w-5 shrink-0" />
              フォルダ名を変更
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onDelete(folder);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <Trash2 className="h-5 w-5 shrink-0" />
              フォルダを削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TopDropZone({ canEdit }: { canEdit: boolean }) {
  const { isOver, setNodeRef } = useDroppable({
    id: TOP_DROP_ID,
    disabled: !canEdit,
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        "mt-3 flex items-center gap-2 rounded-2xl border border-dashed px-4 py-3 text-sm font-bold transition-colors",
        isOver
          ? "border-blue-400 bg-blue-50 text-blue-700 ring-2 ring-blue-300 dark:border-blue-500 dark:bg-blue-950/30 dark:text-blue-200"
          : "border-gray-300 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
      ].join(" ")}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" />
      トップ（フォルダなし）
    </div>
  );
}

function FileActionPanel({
  doc: d,
  canManage,
  onClose,
  onPreview,
  onDownload,
  onMove,
  onEditTags,
  onDelete,
  onShare,
}: {
  doc: DocFile;
  canManage: boolean;
  onClose: () => void;
  onPreview: (d: DocFile) => void;
  onDownload: (d: DocFile) => void;
  onMove: (d: DocFile) => void;
  onEditTags: (d: DocFile) => void;
  onDelete: (id: string) => void;
  onShare?: (d: DocFile) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="w-full select-none rounded-3xl bg-white p-4 shadow-2xl dark:bg-gray-900 sm:max-w-sm"
        style={{
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <div
            className={[
              "grid h-12 w-12 shrink-0 place-items-center rounded-2xl",
              fileColor(d.fileType),
            ].join(" ")}
          >
            <FileTypeIcon
              fileType={d.fileType}
              className="h-6 w-6 text-gray-600 dark:text-gray-300"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold text-gray-900 dark:text-gray-100">
              {d.name}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {formatFileSize(d.fileSize)}
            </p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => {
              onPreview(d);
              onClose();
            }}
            className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <ZoomIn className="h-5 w-5 shrink-0" />
            プレビュー
          </button>
          {onShare && (
            <button
              type="button"
              onClick={() => {
                onShare(d);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              <Share2 className="h-5 w-5 shrink-0" />
              写真に保存（共有）
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onDownload(d);
              onClose();
            }}
            className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <Download className="h-5 w-5 shrink-0" />
            ダウンロード
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onEditTags(d);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              <Tag className="h-5 w-5 shrink-0" />
              タグを編集
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onMove(d);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              <FolderInput className="h-5 w-5 shrink-0" />
              フォルダへ移動
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onDelete(d.id);
                onClose();
              }}
              className="flex items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-extrabold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <Trash2 className="h-5 w-5 shrink-0" />
              削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ページ本体 ────────────────────────────────────────────────
export default function DocumentsPage() {
  const params = useParams<{ projectId: string }>();
  const sp = useSearchParams();
  const projectId = params?.projectId ?? "";
  const projectName = safeDecode(sp.get("projectName"));

  const { me, myRole, roleLoading } = useProjectRole(projectId);
  const isOwnerOrAdmin = myRole === "owner" || myRole === "admin";
  // member ロールは閲覧のみ（追加・移動・削除・フォルダ操作は owner/admin のみ）
  const canAdd = Boolean(me) && isOwnerOrAdmin;

  const [rawDocs, setRawDocs] = useState<DocFile[]>([]);
  const [orderedDocs, setOrderedDocs] = useState<DocFile[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [savedOrder, setSavedOrder] = useState<string[] | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocFile | null>(null);
  const [actionDoc, setActionDoc] = useState<DocFile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagTarget, setTagTarget] = useState<DocFile | null>(null);
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [docReadAtById, setDocReadAtById] = useState<Record<string, number>>(
    {},
  );
  const [docCommentsById, setDocCommentsById] = useState<
    Record<string, DocCommentMeta[]>
  >({});

  // ── フォルダ管理 ──
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<
    null | { type: "create" } | { type: "rename"; folder: DocFolder }
  >(null);
  const [folderActionTarget, setFolderActionTarget] =
    useState<DocFolder | null>(null);
  const [folderNameInput, setFolderNameInput] = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<DocFolder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [moveTarget, setMoveTarget] = useState<DocFile | null>(null);
  const [moving, setMoving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const deleteDocumentViaApi = useCallback(
    async (docId: string, idToken: string) => {
      const res = await fetch("/api/proclink/documents/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ projectId, docId }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error || `DELETE_FAILED_${res.status}`);
      }
    },
    [projectId],
  );

  const canManageDoc = useCallback(
    (_docItem: DocFile) => isOwnerOrAdmin,
    [isOwnerOrAdmin],
  );

  const canManageFolder = useCallback(
    (_folder: DocFolder) => isOwnerOrAdmin,
    [isOwnerOrAdmin],
  );

  // 順序ドキュメントを読む
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    (async () => {
      try {
        const snap = await getDoc(
          doc(db, "projects", projectId, "documentsConfig", "order"),
        );
        if (!alive) return;
        if (snap.exists()) {
          const data = snap.data() as { ids?: string[] };
          setSavedOrder(Array.isArray(data.ids) ? data.ids : null);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  // ファイル一覧を購読
  useEffect(() => {
    if (!projectId) {
      setDocsLoading(false);
      return;
    }
    const q = query(
      collection(db, "projects", projectId, "documents"),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRawDocs(
          snap.docs.map((d) => {
            const data = d.data() as Omit<DocFile, "id">;
            return {
              id: d.id,
              ...data,
              tags: normalizeTags(data.tags),
            };
          }),
        );
        setDocsLoading(false);
      },
      () => setDocsLoading(false),
    );
    return () => unsub();
  }, [projectId]);

  // フォルダ一覧を購読
  useEffect(() => {
    if (!projectId) {
      setFoldersLoading(false);
      return;
    }
    const q = query(
      collection(db, "projects", projectId, "documentsFolders"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setFolders(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<DocFolder, "id">),
          })),
        );
        setFolderError("");
        setFoldersLoading(false);
      },
      (e) => {
        console.error("documents folders snapshot error:", e);
        setFolderError(
          "フォルダ一覧の読み込みに失敗しました。権限または通信状態を確認してください。",
        );
        setFoldersLoading(false);
      },
    );
    return () => unsub();
  }, [projectId]);

  // 開いているフォルダが（他の管理者により）削除されたらトップへ戻す
  useEffect(() => {
    if (!currentFolderId || foldersLoading) return;
    if (!folders.some((f) => f.id === currentFolderId)) {
      setCurrentFolderId(null);
    }
  }, [currentFolderId, folders, foldersLoading]);

  // rawDocs + savedOrder → orderedDocs
  useEffect(() => {
    if (savedOrder === null) {
      setOrderedDocs(rawDocs);
      return;
    }
    const map = new Map(rawDocs.map((d) => [d.id, d]));
    const ordered: DocFile[] = [];
    for (const id of savedOrder) {
      const d = map.get(id);
      if (d) ordered.push(d);
    }
    // 順序未登録の新着ファイルを末尾に追加
    for (const d of rawDocs) {
      if (!savedOrder.includes(d.id)) ordered.push(d);
    }
    setOrderedDocs(ordered);
  }, [rawDocs, savedOrder]);

  const saveOrder = useCallback(
    async (ids: string[]) => {
      if (!projectId) return;
      try {
        await setDoc(
          doc(db, "projects", projectId, "documentsConfig", "order"),
          { ids },
          { merge: true },
        );
        setSavedOrder(ids);
      } catch {
        // ignore
      }
    },
    [projectId],
  );

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const updateDocumentFolder = useCallback(
    async (docId: string, folderId: string | null) => {
      if (!projectId) return;

      const target = rawDocs.find((d) => d.id === docId);
      if (!target || (target.folderId ?? null) === folderId) return;

      setFolderError("");
      setRawDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, folderId } : d)),
      );
      setOrderedDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, folderId } : d)),
      );

      try {
        await updateDoc(doc(db, "projects", projectId, "documents", docId), {
          folderId,
        });
      } catch (e) {
        console.error("documents folder move error:", e);
        setRawDocs((prev) =>
          prev.map((d) =>
            d.id === docId ? { ...d, folderId: target.folderId ?? null } : d,
          ),
        );
        setOrderedDocs((prev) =>
          prev.map((d) =>
            d.id === docId ? { ...d, folderId: target.folderId ?? null } : d,
          ),
        );
        setFolderError(
          "ファイルを移動できませんでした。権限または通信状態を確認してください。",
        );
      }
    },
    [projectId, rawDocs],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeDoc = orderedDocs.find((d) => d.id === active.id);
      if (!activeDoc || !canManageDoc(activeDoc)) return;

      const destinationFolderId = folderIdFromDropId(String(over.id));
      if (destinationFolderId !== undefined) {
        void updateDocumentFolder(String(active.id), destinationFolderId);
        return;
      }

      setOrderedDocs((prev) => {
        const oldIdx = prev.findIndex((d) => d.id === active.id);
        const newIdx = prev.findIndex((d) => d.id === over.id);
        if (oldIdx < 0 || newIdx < 0) return prev;
        const next = arrayMove(prev, oldIdx, newIdx);
        void saveOrder(next.map((d) => d.id));
        return next;
      });
    },
    [canManageDoc, orderedDocs, saveOrder, updateDocumentFolder],
  );

  const uploadFile = useCallback(
    async (file: File, folderIdOverride?: string | null) => {
      if (!me || !projectId) return;
      const uploadLimit = uploadLimitForFile(file);
      if (file.size > uploadLimit) {
        setUploadError(
          isVideoFile(file)
            ? `動画の容量が${uploadLimitLabelForFile(file)}を超えています。短く撮影するか、画質を下げる、または分割してアップロードしてください。`
            : `ファイルサイズは${uploadLimitLabelForFile(file)}以下にしてください。`,
        );
        return;
      }
      setUploading(true);
      setUploadProgress(0);
      setUploadError("");
      try {
        const safeName = file.name.replace(/[#[\]*?]/g, "_");
        const path = `projects/${projectId}/documents/${Date.now()}_${safeName}`;
        const ref = storageRef(storage, path);
        const contentType = inferUploadContentType(file);

        await new Promise<void>((resolve, reject) => {
          const task = uploadBytesResumable(ref, file, {
            contentType,
          });
          task.on(
            "state_changed",
            (s) =>
              setUploadProgress(
                Math.round((s.bytesTransferred / s.totalBytes) * 100),
              ),
            reject,
            () => resolve(),
          );
        });

        const downloadUrl = await getDownloadURL(ref);
        const newDocRef = doc(
          collection(db, "projects", projectId, "documents"),
        );
        await setDoc(newDocRef, {
          name: file.name,
          storagePath: path,
          downloadUrl,
          fileType: contentType,
          fileSize: file.size,
          uploadedBy: me.uid,
          uploadedByName: me.displayName ?? me.email ?? "不明",
          createdAt: serverTimestamp(),
          // 開いているフォルダに入れる（トップなら null）
          folderId:
            folderIdOverride !== undefined ? folderIdOverride : currentFolderId,
          tags: [],
        });
      } catch {
        setUploadError("アップロードに失敗しました。もう一度試してください。");
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [currentFolderId, me, projectId],
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => void uploadFile(f));
    e.target.value = "";
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setUploadError("");

    try {
      const droppedFolders = await getDroppedFolders(e.dataTransfer.items);
      if (droppedFolders.length > 0) {
        for (const folder of droppedFolders) {
          const files = folder.files;
          if (files.length === 0) continue;
          const folderId = await createFolder(folder.name);
          for (const file of files) {
            await uploadFile(file, folderId);
          }
        }
        return;
      }
    } catch (error) {
      console.error("documents folder drop error:", error);
      setUploadError(
        "フォルダの読み込みに失敗しました。ファイル単位でアップロードしてください。",
      );
      return;
    }

    for (const file of Array.from(e.dataTransfer.files)) {
      await uploadFile(file);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId || !projectId) return;
    const target = orderedDocs.find((d) => d.id === deleteConfirmId);
    if (!target) return;
    if (!me) {
      setUploadError("ログイン情報を確認できないため削除できませんでした。");
      setDeleteConfirmId(null);
      return;
    }
    if (!canManageDoc(target)) {
      setUploadError(
        "ファイルを削除できるのは管理者または追加した本人のみです。",
      );
      setDeleteConfirmId(null);
      return;
    }
    setDeleting(true);
    try {
      const idToken = await me.getIdToken();
      await deleteDocumentViaApi(deleteConfirmId, idToken);
      // 順序からも除去
      const newOrder = (savedOrder ?? orderedDocs.map((d) => d.id)).filter(
        (id) => id !== deleteConfirmId,
      );
      await saveOrder(newOrder);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      setUploadError(`ファイルの削除に失敗しました: ${msg}`);
    } finally {
      setDeleting(false);
      setDeleteConfirmId(null);
    }
  };

  // /api/download (同一オリジン) 経由でプロキシすることで CORS を回避し
  // download 属性が確実に効く同一オリジンリンクとしてダウンロードさせる
  const handleDownload = useCallback((d: DocFile) => {
    const params = new URLSearchParams({ url: d.downloadUrl, name: d.name });
    const a = document.createElement("a");
    a.href = `/api/download?${params.toString()}`;
    a.download = d.name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  // ── 共有シート経由の「写真に保存」 ──
  // iOS/Android では共有シートの「画像を保存」で写真アプリに保存できる。
  // 注意: iOS Safari はタップ後に fetch を挟むとユーザー操作の有効期限
  // （transient activation）が切れ、navigator.share が NotAllowedError になる。
  // そのためプレビュー/メニューを開いた時点で File を事前取得しておき、
  // タップ時は待ち時間ゼロで share を呼ぶ。
  const [shareFile, setShareFile] = useState<{ id: string; file: File } | null>(
    null,
  );
  // Web Share API は HTTPS（secure context）でのみ利用可能。
  // http://192.168.x.x:3000 のようなLAN開発環境では navigator.share が存在しないため、
  // 紛らわしい「写真に保存」ボタン自体を表示しない（本番HTTPSでは表示される）。
  const [shareSupported, setShareSupported] = useState(false);
  useEffect(() => {
    setShareSupported(
      typeof window !== "undefined" &&
        window.isSecureContext &&
        typeof navigator.share === "function",
    );
  }, []);

  useEffect(() => {
    const target =
      selectedDoc && selectedDoc.fileType.startsWith("image/")
        ? selectedDoc
        : actionDoc && actionDoc.fileType.startsWith("image/")
          ? actionDoc
          : null;
    if (!target || shareFile?.id === target.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({
          url: target.downloadUrl,
          name: target.name,
        });
        const res = await fetch(`/api/download?${params.toString()}`);
        if (!res.ok) return;
        const blob = await res.blob();
        if (!cancelled) {
          setShareFile({ id: target.id, file: buildShareImageFile(blob, target) });
        }
      } catch {
        // 取得失敗時はタップ時のフォールバックに任せる
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDoc, actionDoc, shareFile?.id]);

  const shareToPhotos = useCallback(
    async (d: DocFile) => {
      try {
        if (typeof navigator.share !== "function") {
          throw new Error("unsupported");
        }
        let file = shareFile?.id === d.id ? shareFile.file : null;
        if (!file) {
          // 事前取得が間に合っていない場合はその場で取得
          // （iOSではユーザー操作の期限切れで失敗することがある → 再タップを案内）
          const params = new URLSearchParams({
            url: d.downloadUrl,
            name: d.name,
          });
          const res = await fetch(`/api/download?${params.toString()}`);
          if (!res.ok) throw new Error("fetch_failed");
          const blob = await res.blob();
          file = buildShareImageFile(blob, d);
          setShareFile({ id: d.id, file });
        }
        if (
          typeof navigator.canShare === "function" &&
          !navigator.canShare({ files: [file] })
        ) {
          throw new Error("unsupported");
        }
        await navigator.share({ files: [file] });
      } catch (e) {
        // 共有シートのキャンセルは何もしない
        if (e instanceof Error && e.name === "AbortError") return;
        // ユーザー操作の期限切れ：ファイルは取得済みなので再タップで成功する
        if (e instanceof Error && e.name === "NotAllowedError") {
          window.alert(
            "画像の準備に時間がかかりました。もう一度「写真に保存」をタップしてください。",
          );
          return;
        }
        // 共有できない環境では通常ダウンロードにフォールバック
        handleDownload(d);
      }
    },
    [shareFile, handleDownload],
  );

  const handleCopyLink = async (d: DocFile) => {
    try {
      // /api/download 経由の URL をコピーすることで
      // リンクをクリックしたときにブラウザ表示ではなくダウンロードが始まる
      const params = new URLSearchParams({ url: d.downloadUrl, name: d.name });
      const link = `${window.location.origin}/api/download?${params.toString()}`;
      await navigator.clipboard.writeText(link);
      setCopiedId(d.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* ignore */
    }
  };

  // ── フォルダ操作 ──
  const currentFolder = useMemo(
    () => folders.find((f) => f.id === currentFolderId) ?? null,
    [folders, currentFolderId],
  );

  // 表示対象：開いているフォルダ内をファイル名・追加者・タグで絞り込む
  const folderDocs = useMemo(
    () => orderedDocs.filter((d) => (d.folderId ?? null) === currentFolderId),
    [orderedDocs, currentFolderId],
  );

  const availableTags = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const d of folderDocs) {
      for (const tag of normalizeTags(d.tags)) {
        const key = tag.toLocaleLowerCase("ja-JP");
        const current = counts.get(key);
        counts.set(key, {
          label: current?.label ?? tag,
          count: (current?.count ?? 0) + 1,
        });
      }
    }
    return [...counts.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "ja"),
    );
  }, [folderDocs]);

  const tagPickerOptions = useMemo(() => {
    const labels = [
      ...STANDARD_DOCUMENT_TAGS,
      ...orderedDocs.flatMap((documentItem) =>
        normalizeTags(documentItem.tags),
      ),
    ];
    const seen = new Set<string>();
    return labels.filter((label) => {
      const key = label.toLocaleLowerCase("ja-JP");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [orderedDocs]);

  const visibleDocs = useMemo(() => {
    const selectedTagKey = selectedTag?.toLocaleLowerCase("ja-JP") ?? null;
    return folderDocs.filter(
      (d) =>
        matchesDocumentSearch(d, searchQuery) &&
        (!selectedTagKey ||
          normalizeTags(d.tags).some(
            (tag) => tag.toLocaleLowerCase("ja-JP") === selectedTagKey,
          )),
    );
  }, [folderDocs, searchQuery, selectedTag]);

  const isFiltering = Boolean(searchQuery.trim() || selectedTag);

  useEffect(() => {
    if (!selectedTag) return;
    const key = selectedTag.toLocaleLowerCase("ja-JP");
    if (
      !availableTags.some(
        (tag) => tag.label.toLocaleLowerCase("ja-JP") === key,
      )
    ) {
      setSelectedTag(null);
    }
  }, [availableTags, selectedTag]);

  const visibleDocIds = useMemo(
    () => visibleDocs.map((d) => d.id),
    [visibleDocs],
  );

  // ── 複数選択してまとめてダウンロード ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [bulkError, setBulkError] = useState("");

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) {
        setSelectedIds(new Set());
        setBulkError("");
      }
      return !prev;
    });
  };

  const toggleSelected = useCallback((d: DocFile) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(d.id)) next.delete(d.id);
      else next.add(d.id);
      return next;
    });
  }, []);

  const allVisibleSelected =
    visibleDocs.length > 0 && visibleDocs.every((d) => selectedIds.has(d.id));

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const d of visibleDocs) next.delete(d.id);
      } else {
        for (const d of visibleDocs) next.add(d.id);
      }
      return next;
    });
  };

  // 複数ファイルを /api/download 経由で取得し、1つのzipにまとめて保存する
  const zipAndSaveFiles = useCallback(
    async (targets: DocFile[], zipBaseName: string): Promise<boolean> => {
      if (targets.length === 0 || bulkDownloading) return false;
      setBulkError("");

      // 1件だけなら通常ダウンロード（zip化しない）
      if (targets.length === 1) {
        handleDownload(targets[0]);
        return true;
      }

      setBulkDownloading(true);
      setBulkProgress({ done: 0, total: targets.length });
      try {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const usedNames = new Set<string>();
        for (const d of targets) {
          const params = new URLSearchParams({
            url: d.downloadUrl,
            name: d.name,
          });
          const res = await fetch(`/api/download?${params.toString()}`);
          if (!res.ok) throw new Error(`「${d.name}」の取得に失敗しました`);
          const blob = await res.blob();
          let name = d.name.trim() || "file";
          // zip内のファイル名重複は (2) などを付けて回避
          if (usedNames.has(name)) {
            const dot = name.lastIndexOf(".");
            const base = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : "";
            let i = 2;
            while (usedNames.has(`${base}(${i})${ext}`)) i += 1;
            name = `${base}(${i})${ext}`;
          }
          usedNames.add(name);
          zip.file(name, blob);
          setBulkProgress((p) => ({ ...p, done: p.done + 1 }));
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const dateStr = new Date()
          .toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })
          .replace(/-/g, "");
        const prefix = zipBaseName.replace(/[\\/:*?"<>|]/g, "_");
        saveAs(zipBlob, `${prefix}_${dateStr}.zip`);
        return true;
      } catch (e) {
        setBulkError(
          e instanceof Error ? e.message : "まとめてダウンロードに失敗しました",
        );
        return false;
      } finally {
        setBulkDownloading(false);
      }
    },
    [bulkDownloading, handleDownload],
  );

  // 選択モード：チェックしたファイルをまとめてダウンロード
  const bulkDownload = useCallback(async () => {
    const targets = orderedDocs.filter((d) => selectedIds.has(d.id));
    const ok = await zipAndSaveFiles(targets, `${projectName || "書類"}_保管庫`);
    if (ok) {
      setSelectMode(false);
      setSelectedIds(new Set());
    }
  }, [orderedDocs, selectedIds, zipAndSaveFiles, projectName]);

  // フォルダの右クリック（PC）/ 長押し（スマホ）メニュー：フォルダ内の全ファイルをまとめてダウンロード
  const downloadFolderFiles = useCallback(
    async (folder: DocFolder) => {
      const targets = orderedDocs.filter(
        (d) => (d.folderId ?? null) === folder.id,
      );
      if (targets.length === 0) {
        setBulkError(`「${folder.name}」にはファイルがありません。`);
        return;
      }
      await zipAndSaveFiles(targets, `${projectName || "書類"}_${folder.name}`);
    },
    [orderedDocs, zipAndSaveFiles, projectName],
  );

  useEffect(() => {
    if (!projectId || !me?.uid || visibleDocIds.length === 0) {
      setDocReadAtById({});
      return;
    }

    const unsubs = visibleDocIds.map((docId) =>
      onSnapshot(
        doc(
          db,
          "projects",
          projectId,
          "documents",
          docId,
          "readStates",
          me.uid,
        ),
        (snap) => {
          const data = snap.exists()
            ? (snap.data() as { lastReadAt?: unknown })
            : null;
          const lastReadAt = toMillis(data?.lastReadAt);
          setDocReadAtById((prev) => ({ ...prev, [docId]: lastReadAt }));
        },
        () => {
          setDocReadAtById((prev) => ({ ...prev, [docId]: 0 }));
        },
      ),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [projectId, me?.uid, visibleDocIds]);

  useEffect(() => {
    if (!projectId || !me?.uid || visibleDocIds.length === 0) {
      setDocCommentsById({});
      return;
    }

    const unsubs = visibleDocIds.map((docId) => {
      const commentsQuery = query(
        collection(db, "projects", projectId, "documents", docId, "comments"),
        orderBy("createdAt", "asc"),
      );
      return onSnapshot(
        commentsQuery,
        (snap) => {
          const comments = snap.docs.map((commentDoc) => {
            const data = commentDoc.data() as {
              authorUid?: unknown;
              createdAt?: unknown;
            };
            return {
              authorUid:
                typeof data.authorUid === "string" ? data.authorUid : "",
              createdAt: data.createdAt,
            };
          });
          setDocCommentsById((prev) => ({ ...prev, [docId]: comments }));
        },
        () => {
          setDocCommentsById((prev) => ({ ...prev, [docId]: [] }));
        },
      );
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [projectId, me?.uid, visibleDocIds]);

  const unreadCommentCounts = useMemo(() => {
    const myUid = me?.uid;
    if (!myUid) return {};

    const counts: Record<string, number> = {};
    for (const docId of visibleDocIds) {
      const lastReadAt = docReadAtById[docId] ?? 0;
      const comments = docCommentsById[docId] ?? [];
      counts[docId] = comments.filter(
        (comment) =>
          comment.authorUid &&
          comment.authorUid !== myUid &&
          toMillis(comment.createdAt) > lastReadAt,
      ).length;
    }
    return counts;
  }, [docCommentsById, docReadAtById, me?.uid, visibleDocIds]);

  useEffect(() => {
    if (!projectId || !me?.uid || !selectedDoc) return;

    const openedDocId = selectedDoc.id;
    setDocReadAtById((prev) => ({ ...prev, [openedDocId]: Date.now() }));
    void setDoc(
      doc(
        db,
        "projects",
        projectId,
        "documents",
        openedDocId,
        "readStates",
        me.uid,
      ),
      { lastReadAt: serverTimestamp() },
      { merge: true },
    ).catch((error) => {
      console.log("documents readState save error:", error);
    });
  }, [projectId, me?.uid, selectedDoc]);

  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of rawDocs) {
      if (d.folderId) map.set(d.folderId, (map.get(d.folderId) ?? 0) + 1);
    }
    return map;
  }, [rawDocs]);

  const openCreateFolder = () => {
    setFolderNameInput("");
    setFolderError("");
    setFolderModal({ type: "create" });
  };

  const openRenameFolder = (folder: DocFolder) => {
    setFolderNameInput(folder.name);
    setFolderError("");
    setFolderModal({ type: "rename", folder });
  };

  const createFolder = useCallback(
    async (name: string): Promise<string> => {
      if (!projectId) throw new Error("projectId is required");

      const newRef = doc(
        collection(db, "projects", projectId, "documentsFolders"),
      );
      await setDoc(newRef, {
        name,
        createdAt: serverTimestamp(),
        createdBy: me?.uid ?? "",
        createdByName: me?.displayName ?? me?.email ?? "不明",
      });

      setFolders((prev) => {
        if (prev.some((f) => f.id === newRef.id)) return prev;
        return [
          ...prev,
          {
            id: newRef.id,
            name,
            createdAt: null,
            createdBy: me?.uid ?? "",
            createdByName: me?.displayName ?? me?.email ?? "不明",
          },
        ];
      });

      return newRef.id;
    },
    [me?.displayName, me?.email, me?.uid, projectId],
  );

  const handleFolderSave = async () => {
    const name = folderNameInput.trim();
    if (!name || !projectId || folderSaving) return;
    setFolderSaving(true);
    setFolderError("");
    try {
      if (folderModal?.type === "rename") {
        if (!canManageFolder(folderModal.folder)) {
          setFolderError(
            "フォルダ名を変更できるのは管理者または追加した本人のみです。",
          );
          return;
        }
        await updateDoc(
          doc(
            db,
            "projects",
            projectId,
            "documentsFolders",
            folderModal.folder.id,
          ),
          { name },
        );
        setFolders((prev) =>
          prev.map((f) =>
            f.id === folderModal.folder.id ? { ...f, name } : f,
          ),
        );
      } else {
        await createFolder(name);
      }
      setFolderModal(null);
      setFolderNameInput("");
    } catch (e) {
      console.error("documents folder save error:", e);
      setFolderError(
        "フォルダを保存できませんでした。権限または通信状態を確認してください。",
      );
    } finally {
      setFolderSaving(false);
    }
  };

  // フォルダ削除：中のファイルも含めて削除する
  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget || !projectId || deletingFolder) return;
    if (!me) {
      setFolderError("ログイン情報を確認できないため削除できませんでした。");
      setDeleteFolderTarget(null);
      return;
    }
    if (!canManageFolder(deleteFolderTarget)) {
      setFolderError(
        "フォルダを削除できるのは管理者または追加した本人のみです。",
      );
      setDeleteFolderTarget(null);
      return;
    }
    setDeletingFolder(true);
    try {
      const docsInFolder = rawDocs.filter(
        (docItem) => docItem.folderId === deleteFolderTarget.id,
      );

      const undeletable = docsInFolder.filter(
        (docItem) => !canManageDoc(docItem),
      );
      if (undeletable.length > 0) {
        setFolderError(
          "フォルダ内に削除権限のないファイルが含まれるため一括削除できません。",
        );
        return;
      }

      const idToken = await me.getIdToken();
      await Promise.all(
        docsInFolder.map((docItem) =>
          deleteDocumentViaApi(docItem.id, idToken),
        ),
      );

      const batch = writeBatch(db);
      batch.delete(
        doc(
          db,
          "projects",
          projectId,
          "documentsFolders",
          deleteFolderTarget.id,
        ),
      );
      await batch.commit();
      const remainingOrder = (
        savedOrder ?? orderedDocs.map((d) => d.id)
      ).filter((id) => !docsInFolder.some((docItem) => docItem.id === id));
      await saveOrder(remainingOrder);
      if (currentFolderId === deleteFolderTarget.id) setCurrentFolderId(null);
      setFolderActionTarget(null);
      setDeleteFolderTarget(null);
    } catch (error) {
      console.error("documents folder delete error:", error);
      setFolderError(
        "フォルダまたは中のファイルを削除できませんでした。権限または通信状態を確認してください。",
      );
    } finally {
      setDeletingFolder(false);
    }
  };

  const handleMoveTo = async (folderId: string | null) => {
    if (!moveTarget || moving) return;
    if (!canManageDoc(moveTarget)) return;
    setMoving(true);
    try {
      await updateDocumentFolder(moveTarget.id, folderId);
      setMoveTarget(null);
    } finally {
      setMoving(false);
    }
  };

  const openTagEditor = (documentItem: DocFile) => {
    setTagTarget(documentItem);
    setTagDraft(normalizeTags(documentItem.tags));
    setTagInput("");
    setTagError("");
  };

  const addTagToDraft = () => {
    const candidates = tagInput
      .split(/[,、]/)
      .map((value) => value.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean);
    if (candidates.length === 0) return;

    const next = normalizeTags([...tagDraft, ...candidates]);
    if (next.length === tagDraft.length) {
      setTagError("同じタグは追加できません。");
      return;
    }
    if (tagDraft.length + candidates.length > MAX_TAGS_PER_DOCUMENT) {
      setTagError(`タグは1ファイルにつき${MAX_TAGS_PER_DOCUMENT}件までです。`);
    } else {
      setTagError("");
    }
    setTagDraft(next);
    setTagInput("");
  };

  const handleTagSave = async () => {
    if (!tagTarget || !projectId || tagSaving) return;
    if (!canManageDoc(tagTarget)) {
      setTagError("タグを編集できるのはオーナーまたは管理者のみです。");
      return;
    }
    const tags = normalizeTags(tagDraft);
    setTagSaving(true);
    setTagError("");
    try {
      await updateDoc(
        doc(db, "projects", projectId, "documents", tagTarget.id),
        { tags },
      );
      const updateTags = (item: DocFile) =>
        item.id === tagTarget.id ? { ...item, tags } : item;
      setRawDocs((prev) => prev.map(updateTags));
      setOrderedDocs((prev) => prev.map(updateTags));
      setSelectedDoc((prev) => (prev ? updateTags(prev) : prev));
      setActionDoc((prev) => (prev ? updateTags(prev) : prev));
      setTagTarget(null);
    } catch (error) {
      console.error("documents tag save error:", error);
      setTagError(
        "タグを保存できませんでした。権限または通信状態を確認してください。",
      );
    } finally {
      setTagSaving(false);
    }
  };

  const isLoading = docsLoading || roleLoading;

  return (
    <main className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <div
        className={[
          "mx-auto w-full max-w-3xl px-4 py-8",
          // 選択モード中は下部固定バーに隠れないよう余白を確保
          selectMode ? "pb-48" : "",
        ].join(" ")}
      >
        {/* ヘッダー */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            保管庫
          </h1>
          {projectName && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              工事：{projectName}
            </p>
          )}
          {!roleLoading && myRole === "member" && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              閲覧のみ可能です。追加・移動・削除はオーナー/管理者のみ行えます。
            </p>
          )}
        </div>

        {/* フォルダ内表示のパンくず */}
        {currentFolder && (
          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentFolderId(null)}
              aria-label="トップに戻る"
              className="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Folder
              className="h-5 w-5 shrink-0 text-amber-500"
              fill="currentColor"
              fillOpacity={0.2}
            />
            <span className="truncate text-base font-extrabold text-gray-900 dark:text-gray-100">
              {currentFolder.name}
            </span>
          </div>
        )}

        {/* アップロードエリア */}
        {!roleLoading && canAdd && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
            className={[
              "mt-6 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 transition-colors",
              dragOver
                ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/20"
                : "border-gray-300 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-900/70",
            ].join(" ")}
          >
            {uploading ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-gray-500" />
                <p className="text-sm font-bold text-gray-700 dark:text-gray-200">
                  アップロード中… {uploadProgress}%
                </p>
                <div className="h-2 w-48 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <UploadCloud className="h-8 w-8 text-gray-400" />
                <p className="text-center text-sm font-bold text-gray-700 dark:text-gray-200">
                  クリックまたはドラッグ＆ドロップでファイル・フォルダを追加
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  PDF・Excel・Word・PowerPoint・CSV・テキスト・画像は50MBまで
                </p>
                <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                  動画（mp4・mov・webm）は200MBまで（目安: 1080pで約5〜10分）
                </p>
                {currentFolder && (
                  <p className="text-xs font-bold text-amber-700 dark:text-amber-400">
                    「{currentFolder.name}」フォルダに追加されます
                  </p>
                )}
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED}
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        )}

        {uploadError && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
            <span className="flex-1">{uploadError}</span>
            <button type="button" onClick={() => setUploadError("")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {!isLoading && folderDocs.length > 0 && (
          <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="ファイル名・追加者・タグで検索"
                aria-label="保管庫を検索"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-10 text-sm text-gray-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-400/20 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:bg-gray-900"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="検索語を消去"
                  className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {availableTags.length > 0 && (
              <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
                <Tag className="h-4 w-4 shrink-0 text-gray-400" />
                <button
                  type="button"
                  onClick={() => setSelectedTag(null)}
                  className={[
                    "shrink-0 rounded-full border px-3 py-1 text-xs font-bold",
                    selectedTag === null
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
                  ].join(" ")}
                >
                  すべて
                </button>
                {availableTags.map((tag) => (
                  <button
                    key={tag.label.toLocaleLowerCase("ja-JP")}
                    type="button"
                    onClick={() =>
                      setSelectedTag((current) =>
                        current?.toLocaleLowerCase("ja-JP") ===
                        tag.label.toLocaleLowerCase("ja-JP")
                          ? null
                          : tag.label,
                      )
                    }
                    className={[
                      "shrink-0 rounded-full border px-3 py-1 text-xs font-bold",
                      selectedTag?.toLocaleLowerCase("ja-JP") ===
                      tag.label.toLocaleLowerCase("ja-JP")
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
                    ].join(" ")}
                  >
                    #{tag.label} {tag.count}
                  </button>
                ))}
              </div>
            )}

            {isFiltering && (
              <p className="mt-2 text-xs font-bold text-gray-500 dark:text-gray-400">
                {folderDocs.length}件中 {visibleDocs.length}件を表示
              </p>
            )}
          </section>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          {/* フォルダ一覧（トップ表示時のみ） */}
          {!isLoading &&
            currentFolderId === null &&
            (folders.length > 0 || canAdd) && (
              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-extrabold text-gray-700 dark:text-gray-300">
                    フォルダ
                  </h2>
                  {canAdd && (
                    <button
                      type="button"
                      onClick={openCreateFolder}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-extrabold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      <FolderPlus className="h-4 w-4" />
                      新しいフォルダ
                    </button>
                  )}
                </div>
                {folderError && (
                  <p className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                    {folderError}
                  </p>
                )}
                {folders.length > 0 && (
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                    {folders.map((f) => (
                      <FolderCard
                        key={f.id}
                        folder={f}
                        count={folderCounts.get(f.id) ?? 0}
                        canManage={canManageFolder(f)}
                        onOpen={setCurrentFolderId}
                        onOpenActions={setFolderActionTarget}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

          {currentFolder && canAdd && <TopDropZone canEdit={canAdd} />}

          {/* ファイル一覧 */}
          <div className="mt-6">
            {!isLoading && orderedDocs.length > 0 && (
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-extrabold text-gray-700 dark:text-gray-300">
                  ファイル
                </h2>
                <button
                  type="button"
                  onClick={toggleSelectMode}
                  className={[
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-extrabold",
                    selectMode
                      ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
                      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800",
                  ].join(" ")}
                >
                  {selectMode ? (
                    <>
                      <X className="h-4 w-4" />
                      キャンセル
                    </>
                  ) : (
                    <>
                      <CheckSquare className="h-4 w-4" />
                      選択
                    </>
                  )}
                </button>
              </div>
            )}
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : visibleDocs.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                {isFiltering
                  ? "検索条件に一致するファイルがありません"
                  : currentFolder
                  ? "このフォルダにはまだファイルがありません"
                  : "まだファイルがアップロードされていません"}
              </div>
            ) : (
              <SortableContext
                items={visibleDocs.map((d) => d.id)}
                strategy={rectSortingStrategy}
              >
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                  {visibleDocs.map((d) => (
                    <SortableCard
                      key={d.id}
                      doc={d}
                      canManage={!isFiltering && canManageDoc(d)}
                      unreadCount={unreadCommentCounts[d.id] ?? 0}
                      onSelect={setSelectedDoc}
                      onOpenActions={setActionDoc}
                      selectMode={selectMode}
                      selected={selectedIds.has(d.id)}
                      onToggleSelect={toggleSelected}
                    />
                  ))}
                </div>
              </SortableContext>
            )}
          </div>
        </DndContext>

        {/* 選択モードの操作バー・一括ダウンロードの進捗（フッターの上に固定表示） */}
        {(selectMode || bulkDownloading || Boolean(bulkError)) && (
          <div
            className="fixed inset-x-0 z-40"
            style={{ bottom: "var(--hooter-height, 61px)" }}
          >
            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              {bulkError && (
                <p className="mb-2 flex items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                  <span>{bulkError}</span>
                  <button
                    type="button"
                    onClick={() => setBulkError("")}
                    aria-label="エラーを閉じる"
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </p>
              )}
              {!selectMode && bulkDownloading && (
                <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                  <span className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                    {bulkProgress.done < bulkProgress.total
                      ? `フォルダ内のファイルを取得中 ${bulkProgress.done}/${bulkProgress.total}`
                      : "圧縮中…"}
                  </span>
                </div>
              )}
              {selectMode && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                <span className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                  {selectedIds.size}件選択中
                </span>
                <div className="flex items-center gap-2">
                  {visibleDocs.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleSelectAllVisible}
                      disabled={bulkDownloading}
                      className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      {allVisibleSelected ? "表示中を解除" : "表示中を全選択"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void bulkDownload()}
                    disabled={selectedIds.size === 0 || bulkDownloading}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-extrabold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {bulkDownloading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {bulkProgress.done < bulkProgress.total
                          ? `取得中 ${bulkProgress.done}/${bulkProgress.total}`
                          : "圧縮中…"}
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4" />
                        まとめてダウンロード
                      </>
                    )}
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
        )}

        {!me && (
          <p className="mt-6 rounded-2xl border bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
            未ログインの可能性があります。必要に応じてログインしてください。
          </p>
        )}
      </div>

      {/* プレビューモーダル */}
      {selectedDoc && (
        <DocPreviewModal
          doc={selectedDoc}
          projectId={projectId}
          me={me}
          isOwner={isOwnerOrAdmin}
          onClose={() => setSelectedDoc(null)}
          onDownload={handleDownload}
          onShare={
            shareSupported && selectedDoc.fileType.startsWith("image/")
              ? (f) => void shareToPhotos(f)
              : undefined
          }
        />
      )}

      {actionDoc && (
        <FileActionPanel
          doc={actionDoc}
          canManage={canManageDoc(actionDoc)}
          onClose={() => setActionDoc(null)}
          onPreview={setSelectedDoc}
          onDownload={handleDownload}
          onMove={setMoveTarget}
          onEditTags={openTagEditor}
          onDelete={setDeleteConfirmId}
          onShare={
            shareSupported && actionDoc.fileType.startsWith("image/")
              ? (f) => void shareToPhotos(f)
              : undefined
          }
        />
      )}

      {/* タグ編集モーダル */}
      {tagTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => !tagSaving && setTagTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-extrabold text-gray-900 dark:text-gray-100">
                  タグを編集
                </p>
                <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                  {tagTarget.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTagTarget(null)}
                disabled={tagSaving}
                aria-label="閉じる"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 min-h-12 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              {tagDraft.length === 0 ? (
                <p className="text-xs text-gray-400">タグはまだありません</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {tagDraft.map((tag) => (
                    <span
                      key={tag.toLocaleLowerCase("ja-JP")}
                      className="inline-flex items-center gap-1 rounded-full bg-blue-100 py-1 pl-3 pr-1.5 text-xs font-bold text-blue-700 dark:bg-blue-950/60 dark:text-blue-200"
                    >
                      #{tag}
                      <button
                        type="button"
                        onClick={() =>
                          setTagDraft((current) =>
                            current.filter(
                              (item) =>
                                item.toLocaleLowerCase("ja-JP") !==
                                tag.toLocaleLowerCase("ja-JP"),
                            ),
                          )
                        }
                        aria-label={`${tag}タグを削除`}
                        className="grid h-5 w-5 place-items-center rounded-full hover:bg-blue-200 dark:hover:bg-blue-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <select
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                autoFocus
                className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="">タグを選択</option>
                {tagPickerOptions.map((tag) => (
                  <option
                    key={tag.toLocaleLowerCase("ja-JP")}
                    value={tag}
                    disabled={tagDraft.some(
                      (selected) =>
                        selected.toLocaleLowerCase("ja-JP") ===
                        tag.toLocaleLowerCase("ja-JP"),
                    )}
                  >
                    {tag}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={addTagToDraft}
                disabled={
                  !tagInput.trim() || tagDraft.length >= MAX_TAGS_PER_DOCUMENT
                }
                className="rounded-xl border border-blue-200 bg-blue-50 px-4 text-sm font-extrabold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200"
              >
                追加
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              一覧から選択して追加・最大{MAX_TAGS_PER_DOCUMENT}件
            </p>

            {tagError && (
              <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                {tagError}
              </p>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                disabled={tagSaving}
                onClick={() => setTagTarget(null)}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={tagSaving}
                onClick={() => void handleTagSave()}
                className="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-extrabold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {tagSaving ? "保存中…" : "タグを保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {folderActionTarget && (
        <FolderActionPanel
          folder={folderActionTarget}
          canManage={canManageFolder(folderActionTarget)}
          onClose={() => setFolderActionTarget(null)}
          onRename={openRenameFolder}
          onDelete={setDeleteFolderTarget}
          onDownload={(f) => void downloadFolderFiles(f)}
        />
      )}

      {/* フォルダ作成・名前変更モーダル */}
      {folderModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => !folderSaving && setFolderModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-extrabold text-gray-900 dark:text-gray-100">
              {folderModal.type === "rename"
                ? "フォルダ名を変更"
                : "新しいフォルダ"}
            </p>
            <input
              type="text"
              value={folderNameInput}
              onChange={(e) => setFolderNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  void handleFolderSave();
                }
              }}
              placeholder="フォルダ名"
              autoFocus
              className="mt-4 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
            {folderError && (
              <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                {folderError}
              </p>
            )}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                disabled={folderSaving}
                onClick={() => setFolderModal(null)}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={folderSaving || !folderNameInput.trim()}
                onClick={() => void handleFolderSave()}
                className="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-extrabold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {folderSaving
                  ? "保存中…"
                  : folderModal.type === "rename"
                    ? "変更する"
                    : "作成する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* フォルダ削除確認モーダル */}
      {deleteFolderTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => !deletingFolder && setDeleteFolderTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-extrabold text-gray-900 dark:text-gray-100">
              「{deleteFolderTarget.name}」を削除しますか？
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              中身のファイル（{folderCounts.get(deleteFolderTarget.id) ?? 0}
              件）も削除されます。削除しますか？
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                disabled={deletingFolder}
                onClick={() => setDeleteFolderTarget(null)}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={deletingFolder}
                onClick={() => void handleDeleteFolder()}
                className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-extrabold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deletingFolder ? "削除中…" : "YES"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ファイル移動先選択モーダル */}
      {moveTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => !moving && setMoveTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="truncate text-base font-extrabold text-gray-900 dark:text-gray-100">
              「{moveTarget.name}」の移動先
            </p>
            <div className="mt-4 flex max-h-72 flex-col gap-2 overflow-y-auto">
              <button
                type="button"
                disabled={moving || (moveTarget.folderId ?? null) === null}
                onClick={() => void handleMoveTo(null)}
                className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-left text-sm font-bold text-gray-800 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <ArrowLeft className="h-4 w-4 shrink-0 text-gray-400" />
                トップ（フォルダなし）
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={moving || moveTarget.folderId === f.id}
                  onClick={() => void handleMoveTo(f.id)}
                  className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-left text-sm font-bold text-gray-800 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <Folder
                    className="h-4 w-4 shrink-0 text-amber-500"
                    fill="currentColor"
                    fillOpacity={0.2}
                  />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
            {folders.length === 0 && (
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                フォルダがまだありません。トップの「新しいフォルダ」から作成できます。
              </p>
            )}
            <button
              type="button"
              disabled={moving}
              onClick={() => setMoveTarget(null)}
              className="mt-4 w-full rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 削除確認モーダル */}
      {deleteConfirmId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => !deleting && setDeleteConfirmId(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-extrabold text-gray-900 dark:text-gray-100">
              ファイルを削除しますか？
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              この操作は取り消せません。
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-extrabold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleDeleteConfirm()}
                className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-extrabold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
