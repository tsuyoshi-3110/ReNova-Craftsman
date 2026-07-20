"use client";
/* eslint-disable @next/next/no-img-element */

import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderArchive,
  FolderInput,
  FolderPlus,
  Link2,
  MessageCircle,
  MoveRight,
  Plus,
  Reply,
  Search,
  Send,
  Trash2,
  UploadCloud,
  ZoomIn,
  X,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query as firestoreQuery,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/lib/firebaseClient";
import { formatYen } from "../calculations";
import {
  createProcNovaVaultFolder,
  deleteProcNovaVaultDocument,
  deleteProjectDocument,
  listInvoices,
  listProcNovaVaultDocuments,
  listProcNovaVaultFolders,
  listProjectDocuments,
  listPurchaseOrders,
  moveProcNovaVaultDocumentToFolder,
  moveProcNovaVaultDocumentToProject,
  moveProjectDocumentToProcNova,
  setProjectDocumentStatus,
  uploadProcNovaVaultDocument,
  uploadProjectDocument,
} from "../services/repository";
import type {
  CompanyMembership,
  Estimate,
  Invoice,
  ProcNovaVaultDocument,
  ProcNovaVaultFolder,
  Project,
  ProjectDocument,
  ProjectDocumentCategory,
  PurchaseOrder,
} from "../types";
import { useProcManaSession } from "./ProcManaProvider";

type Props = {
  project: Project;
  estimates: Estimate[];
  canEdit: boolean;
  demo: boolean;
};

type GeneratedDocument = {
  id: string;
  name: string;
  category: ProjectDocumentCategory;
  detail: string;
  date: string;
  status: string;
  tab: "estimate" | "contract" | "orders" | "invoices";
};

type DocumentOrigin = "procnova" | "procmana";

type DocumentRow = {
  key: string;
  id: string;
  origin: DocumentOrigin;
  name: string;
  category: ProjectDocumentCategory;
  description: string;
  fileUrl: string;
  contentType: string;
  size: number;
  status: "active" | "archived";
  uploadedByName: string;
  createdAt: string;
  folderId: string | null;
  commentCount: number;
  localDocument: ProjectDocument | null;
  vaultDocument: ProcNovaVaultDocument | null;
};

const CATEGORY_LABELS: Record<ProjectDocumentCategory, string> = {
  estimate: "見積",
  contract: "契約",
  order: "発注",
  invoice: "請求",
  drawing: "図面",
  report: "報告書",
  permit: "申請・許可",
  photo: "写真",
  detail_statement: "明細書",
  other: "その他",
};

const CATEGORY_STYLES: Record<ProjectDocumentCategory, string> = {
  estimate: "bg-blue-50 text-blue-700",
  contract: "bg-indigo-50 text-indigo-700",
  order: "bg-cyan-50 text-cyan-700",
  invoice: "bg-emerald-50 text-emerald-700",
  drawing: "bg-violet-50 text-violet-700",
  report: "bg-amber-50 text-amber-800",
  permit: "bg-orange-50 text-orange-700",
  photo: "bg-pink-50 text-pink-700",
  detail_statement: "bg-teal-50 text-teal-700",
  other: "bg-slate-100 text-slate-600",
};

function dateLabel(value: string): string {
  return value ? value.slice(0, 10).replaceAll("-", "/") : "—";
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

function fileIcon(contentType: string, name: string) {
  const value = `${contentType} ${name}`.toLowerCase();
  if (value.includes("image") || /\.(jpe?g|png|gif|webp|heic)$/.test(value)) return <FileImage size={20} />;
  if (value.includes("spreadsheet") || value.includes("excel") || /\.(xlsx?|csv)$/.test(value)) return <FileSpreadsheet size={20} />;
  if (value.includes("pdf") || value.includes("word") || /\.(pdf|docx?)$/.test(value)) return <FileText size={20} />;
  return <File size={20} />;
}

function isImageFile(contentType: string, name: string): boolean {
  return contentType.toLowerCase().includes("image") || /\.(jpe?g|png|gif|webp|heic)$/i.test(name);
}

function fileCardStyle(contentType: string, name: string): string {
  const value = `${contentType} ${name}`.toLowerCase();
  if (value.includes("pdf") || /\.pdf$/i.test(name)) return "bg-rose-100 text-rose-700";
  if (value.includes("spreadsheet") || value.includes("excel") || /\.(xlsx?|csv)$/i.test(name)) return "bg-emerald-100 text-emerald-700";
  if (value.includes("word") || /\.docx?$/i.test(name)) return "bg-blue-100 text-blue-700";
  if (value.includes("powerpoint") || /\.pptx?$/i.test(name)) return "bg-orange-100 text-orange-700";
  if (value.includes("video") || /\.(mp4|mov|webm)$/i.test(name)) return "bg-violet-100 text-violet-700";
  return "bg-slate-100 text-slate-600";
}

function isPdfFile(contentType: string, name: string): boolean {
  return contentType.toLowerCase().includes("pdf") || /\.pdf$/i.test(name);
}

function isVideoFile(contentType: string, name: string): boolean {
  return contentType.toLowerCase().includes("video") || /\.(mp4|mov|webm)$/i.test(name);
}

async function downloadDocumentFile(fileUrl: string, name: string): Promise<void> {
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error("download_failed");
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = window.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.style.display = "none";
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  } catch {
    window.open(fileUrl, "_blank", "noopener,noreferrer");
  }
}

type PreviewComment = {
  id: string;
  text: string;
  authorUid: string;
  authorName: string;
  parentId: string | null;
  createdAt: Timestamp | null;
};

function commentTime(value: Timestamp | null): string {
  if (!value) return "送信中…";
  const date = value.toDate();
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function PreviewComments({
  document,
  project,
  member,
  onCountChange,
}: {
  document: DocumentRow;
  project: Project;
  member: CompanyMembership | null;
  onCountChange: (documentId: string, count: number) => void;
}) {
  const procNovaProjectId = project.procNovaProjectId;
  const supportsComments = document.origin === "procnova" && Boolean(procNovaProjectId);
  const [comments, setComments] = useState<PreviewComment[]>([]);
  const [loading, setLoading] = useState(supportsComments);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supportsComments || !procNovaProjectId) return;
    const commentsQuery = firestoreQuery(
      collection(db, "projects", procNovaProjectId, "documents", document.id, "comments"),
      orderBy("createdAt", "asc"),
    );
    return onSnapshot(
      commentsQuery,
      (snapshot) => {
        const next = snapshot.docs.map((snapshotDocument) => {
          const data = snapshotDocument.data();
          return {
            id: snapshotDocument.id,
            text: typeof data.text === "string" ? data.text : "",
            authorUid: typeof data.authorUid === "string" ? data.authorUid : "",
            authorName: typeof data.authorName === "string" ? data.authorName : "不明",
            parentId: typeof data.parentId === "string" ? data.parentId : null,
            createdAt: data.createdAt instanceof Object && "toDate" in data.createdAt ? data.createdAt as Timestamp : null,
          } satisfies PreviewComment;
        });
        setComments(next);
        setLoading(false);
        onCountChange(document.id, next.length);
      },
      () => {
        setLoading(false);
        setError("コメントを読み込めませんでした。ProcNovaの工事共有権限を確認してください。");
      },
    );
  }, [document.id, onCountChange, procNovaProjectId, supportsComments]);

  const repliesByParent = useMemo(() => {
    const grouped = new Map<string, PreviewComment[]>();
    comments.forEach((comment) => {
      if (!comment.parentId) return;
      grouped.set(comment.parentId, [...(grouped.get(comment.parentId) ?? []), comment]);
    });
    return grouped;
  }, [comments]);
  const topLevel = comments.filter((comment) => !comment.parentId);

  const postComment = useCallback(async (value: string, parentId: string | null) => {
    const body = value.trim();
    if (!body || !member || !procNovaProjectId || posting || !supportsComments) return;
    setPosting(true);
    setError("");
    try {
      const commentRef = doc(collection(db, "projects", procNovaProjectId, "documents", document.id, "comments"));
      await setDoc(commentRef, {
        text: body,
        authorUid: member.uid,
        authorName: member.displayName || member.email || "不明",
        parentId,
        createdAt: serverTimestamp(),
      });
      if (project.siteRole === "owner" || project.siteRole === "admin") {
        await updateDoc(doc(db, "projects", procNovaProjectId, "documents", document.id), { commentCount: increment(1) }).catch(() => undefined);
      }
      if (parentId) {
        setReplyText("");
        setReplyTo(null);
      } else {
        setText("");
      }
    } catch {
      setError("コメントを送信できませんでした。");
    } finally {
      setPosting(false);
    }
  }, [document.id, member, posting, procNovaProjectId, project.siteRole, supportsComments]);

  const removeComment = useCallback(async (comment: PreviewComment) => {
    if (!member || !procNovaProjectId || !supportsComments) return;
    if (!window.confirm("このコメントを削除しますか？")) return;
    const children = comment.parentId ? [] : repliesByParent.get(comment.id) ?? [];
    try {
      await Promise.all([
        deleteDoc(doc(db, "projects", procNovaProjectId, "documents", document.id, "comments", comment.id)),
        ...children.map((child) => deleteDoc(doc(db, "projects", procNovaProjectId, "documents", document.id, "comments", child.id))),
      ]);
      if (project.siteRole === "owner" || project.siteRole === "admin") {
        await updateDoc(doc(db, "projects", procNovaProjectId, "documents", document.id), { commentCount: increment(-(children.length + 1)) }).catch(() => undefined);
      }
    } catch {
      setError("コメントを削除できませんでした。");
    }
  }, [document.id, member, procNovaProjectId, project.siteRole, repliesByParent, supportsComments]);

  const canDelete = (comment: PreviewComment) => Boolean(member) && (
    project.siteRole === "owner" || project.siteRole === "admin" || comment.authorUid === member?.uid
  );

  if (!supportsComments) {
    return <div><p className="flex items-center gap-2 text-sm font-bold text-slate-800"><MessageCircle size={17} />コメント</p><p className="mt-3 rounded-xl bg-slate-50 px-4 py-5 text-center text-xs text-slate-400">ProcMana保管庫のファイルにはコメントは共有されません</p></div>;
  }

  return <div className="space-y-3">
    <p className="flex items-center gap-2 text-sm font-bold text-slate-800"><MessageCircle size={17} />コメント{topLevel.length > 0 && <span className="text-slate-400">（{topLevel.length}）</span>}</p>
    {loading
      ? <div className="flex justify-center py-6"><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" /></div>
      : topLevel.length === 0
        ? <p className="rounded-xl bg-slate-50 px-4 py-5 text-center text-xs text-slate-400">まだコメントはありません</p>
        : <div className="space-y-3">{topLevel.map((comment) => <div key={comment.id} className="rounded-2xl border border-slate-100 p-3">
          <div className="flex items-center gap-2"><span className="text-xs font-bold text-slate-900">{comment.authorName}</span><span className="text-[10px] text-slate-400">{commentTime(comment.createdAt)}</span>{canDelete(comment) && <button type="button" title="削除" aria-label="コメントを削除" className="ml-auto text-slate-300 hover:text-red-500" onClick={() => void removeComment(comment)}><Trash2 size={14} /></button>}</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{comment.text}</p>
          {(repliesByParent.get(comment.id) ?? []).length > 0 && <div className="mt-3 space-y-2 border-l-2 border-slate-100 pl-3">{(repliesByParent.get(comment.id) ?? []).map((reply) => <div key={reply.id}><div className="flex items-center gap-2"><span className="text-xs font-bold text-slate-900">{reply.authorName}</span><span className="text-[10px] text-slate-400">{commentTime(reply.createdAt)}</span>{canDelete(reply) && <button type="button" title="削除" aria-label="返信を削除" className="ml-auto text-slate-300 hover:text-red-500" onClick={() => void removeComment(reply)}><Trash2 size={14} /></button>}</div><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{reply.text}</p></div>)}</div>}
          {replyTo === comment.id
            ? <div className="mt-3 flex gap-2"><input autoFocus className="pm-input min-w-0 flex-1" value={replyText} placeholder="返信を入力" onChange={(event) => setReplyText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void postComment(replyText, comment.id); }} /><button type="button" aria-label="返信を送信" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-600 text-white disabled:opacity-40" disabled={posting || !replyText.trim()} onClick={() => void postComment(replyText, comment.id)}><Send size={16} /></button><button type="button" className="text-xs font-bold text-slate-400" onClick={() => { setReplyTo(null); setReplyText(""); }}>取消</button></div>
            : <div className="mt-2 flex justify-end"><button type="button" title="返信する" aria-label="返信する" className="grid h-8 w-8 place-items-center rounded-full text-blue-600 hover:bg-blue-50" onClick={() => setReplyTo(comment.id)}><Reply size={16} /></button></div>}
        </div>)}</div>}
    {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
    {member && <div className="flex gap-2"><input className="pm-input min-w-0 flex-1" value={text} placeholder="コメントを入力" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void postComment(text, null); }} /><button type="button" aria-label="コメントを送信" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-600 text-white disabled:opacity-40" disabled={posting || !text.trim()} onClick={() => void postComment(text, null)}><Send size={17} /></button></div>}
  </div>;
}

function DocumentPreviewModal({
  document,
  project,
  member,
  onClose,
  onCountChange,
}: {
  document: DocumentRow;
  project: Project;
  member: CompanyMembership | null;
  onClose: () => void;
  onCountChange: (documentId: string, count: number) => void;
}) {
  const isImage = isImageFile(document.contentType, document.name);
  const isPdf = isPdfFile(document.contentType, document.name);
  const isVideo = isVideoFile(document.contentType, document.name);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={`${document.name}のプレビュー`} className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:rounded-[28px]">
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{document.name}</p><p className="mt-1 text-xs text-slate-500">{sizeLabel(document.size)}　{document.uploadedByName || "—"}</p></div>
        {document.fileUrl && <button type="button" title="ダウンロード" aria-label="ダウンロード" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50" onClick={() => void downloadDocumentFile(document.fileUrl, document.name)}><Download size={18} /></button>}
        <button type="button" title="閉じる" aria-label="閉じる" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50" onClick={onClose}><X size={21} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-72 max-h-[45dvh] items-center justify-center overflow-auto bg-slate-50">
          {isImage
            ? <img src={document.fileUrl} alt={document.name} className="max-h-[45dvh] max-w-full object-contain" />
            : isVideo
              ? <video src={document.fileUrl} controls preload="metadata" className="max-h-[45dvh] max-w-full bg-black" />
              : isPdf
                ? <iframe src={document.fileUrl} title={document.name} className="h-[45dvh] w-full border-0" />
                : <div className="flex flex-col items-center gap-5 px-8 py-12"><span className={`grid h-24 w-24 place-items-center rounded-3xl ${fileCardStyle(document.contentType, document.name)} [&>svg]:h-12 [&>svg]:w-12`}>{fileIcon(document.contentType, document.name)}</span><p className="text-center text-sm text-slate-500">このファイル形式はブラウザでプレビューできません</p>{document.fileUrl && <button type="button" className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-6 py-3 text-sm font-bold text-white hover:bg-slate-700" onClick={() => void downloadDocumentFile(document.fileUrl, document.name)}><Download size={17} />ダウンロード</button>}</div>}
        </div>
        <div className="border-t border-slate-100 p-4"><PreviewComments document={document} project={project} member={member} onCountChange={onCountChange} /></div>
      </div>
    </div>
  </div>;
}

function localRow(document: ProjectDocument): DocumentRow {
  return {
    key: `procmana-${document.id}`,
    id: document.id,
    origin: "procmana",
    name: document.name,
    category: document.category,
    description: document.description,
    fileUrl: document.fileUrl,
    contentType: document.contentType,
    size: document.size,
    status: document.status,
    uploadedByName: document.uploadedByName,
    createdAt: document.createdAt,
    folderId: null,
    commentCount: 0,
    localDocument: document,
    vaultDocument: null,
  };
}

function vaultRow(document: ProcNovaVaultDocument): DocumentRow {
  return {
    key: `procnova-${document.id}`,
    id: document.id,
    origin: "procnova",
    name: document.name,
    category: document.category,
    description: document.description,
    fileUrl: document.fileUrl,
    contentType: document.contentType,
    size: document.size,
    status: "active",
    uploadedByName: document.uploadedByName,
    createdAt: document.createdAt,
    folderId: document.folderId,
    commentCount: document.commentCount,
    localDocument: null,
    vaultDocument: document,
  };
}

type DocumentDialog = "preview" | "menu" | "folder" | "vault";

export function DocumentsPanel({ project, estimates, canEdit, demo }: Props) {
  const { member } = useProcManaSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const linked = project.procNovaLinkStatus === "linked" && Boolean(project.procNovaProjectId);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [vaultDocuments, setVaultDocuments] = useState<ProcNovaVaultDocument[]>([]);
  const [vaultFolders, setVaultFolders] = useState<ProcNovaVaultFolder[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [query, setQuery] = useState("");
  const [activeVault, setActiveVault] = useState<DocumentOrigin>(linked ? "procnova" : "procmana");
  const [categoryFilter, setCategoryFilter] = useState<"all" | ProjectDocumentCategory>("all");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<ProjectDocumentCategory>("other");
  const [description, setDescription] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [selectedDocument, setSelectedDocument] = useState<DocumentRow | null>(null);
  const [documentDialog, setDocumentDialog] = useState<DocumentDialog | null>(null);

  const procNovaDocumentsUrl = `${process.env.NEXT_PUBLIC_PROCNOVA_BASE_URL || "http://localhost:3000"}/proclink/projects/${project.procNovaProjectId || project.id}/documents`;

  async function load() {
    const [localResult, vaultResult, foldersResult, ordersResult, invoicesResult] = await Promise.allSettled([
      listProjectDocuments(project.id, demo),
      listProcNovaVaultDocuments(project, demo),
      listProcNovaVaultFolders(project, demo),
      listPurchaseOrders(project.id, demo),
      listInvoices(project.id, demo),
    ]);
    if (localResult.status === "fulfilled") setDocuments(localResult.value);
    if (vaultResult.status === "fulfilled") {
      setVaultDocuments(vaultResult.value);
      setVaultError("");
    } else {
      setVaultError(vaultResult.reason instanceof Error ? vaultResult.reason.message : "ProcNova保管庫を読み込めませんでした。");
    }
    if (foldersResult.status === "fulfilled") setVaultFolders(foldersResult.value);
    if (ordersResult.status === "fulfilled") setOrders(ordersResult.value);
    if (invoicesResult.status === "fulfilled") setInvoices(invoicesResult.value);
    const firstFailure = [localResult, foldersResult, ordersResult, invoicesResult].find((result) => result.status === "rejected");
    if (firstFailure?.status === "rejected") setMessage(firstFailure.reason instanceof Error ? firstFailure.reason.message : "一部の書類を読み込めませんでした。");
  }

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      listProjectDocuments(project.id, demo),
      listProcNovaVaultDocuments(project, demo),
      listProcNovaVaultFolders(project, demo),
      listPurchaseOrders(project.id, demo),
      listInvoices(project.id, demo),
    ])
      .then(([localResult, vaultResult, foldersResult, ordersResult, invoicesResult]) => {
        if (!active) return;
        if (localResult.status === "fulfilled") setDocuments(localResult.value);
        else setMessage(localResult.reason instanceof Error ? localResult.reason.message : "ProcMana保管庫を読み込めませんでした。");
        if (vaultResult.status === "fulfilled") {
          setVaultDocuments(vaultResult.value);
          setVaultError("");
        } else {
          setVaultError(vaultResult.reason instanceof Error ? vaultResult.reason.message : "ProcNova保管庫を読み込めませんでした。");
        }
        if (foldersResult.status === "fulfilled") setVaultFolders(foldersResult.value);
        if (ordersResult.status === "fulfilled") setOrders(ordersResult.value);
        if (invoicesResult.status === "fulfilled") setInvoices(invoicesResult.value);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [demo, project]);

  const generatedDocuments = useMemo<GeneratedDocument[]>(() => {
    const generated: GeneratedDocument[] = estimates.map((estimate) => ({
      id: `estimate-${estimate.id}`,
      name: `${estimate.estimateNumber} ${estimate.subject}`.trim(),
      category: "estimate",
      detail: formatYen(estimate.total),
      date: estimate.updatedAt || estimate.estimateDate,
      status: estimate.status === "adopted" ? "契約採用" : estimate.status === "submitted" ? "提出済み" : "下書き",
      tab: "estimate",
    }));
    if (project.activeContractId || project.lastContractId) {
      generated.push({
        id: `contract-${project.activeContractId ?? project.lastContractId}`,
        name: `${project.name} 契約書`,
        category: "contract",
        detail: formatYen(project.contractAmount),
        date: project.contractConfirmedAt ?? project.contractCancelledAt ?? "",
        status: project.contractState === "active" ? "契約中" : "解除済み",
        tab: "contract",
      });
    }
    orders.filter((order) => order.status !== "draft").forEach((order) => generated.push({
      id: `order-${order.id}`,
      name: `${order.orderNumber} ${order.vendorName}`.trim(),
      category: "order",
      detail: formatYen(order.total),
      date: order.confirmedAt ?? order.orderDate,
      status: order.status === "confirmed" ? "確定" : "取消済み",
      tab: "orders",
    }));
    invoices.filter((invoice) => invoice.status === "issued").forEach((invoice) => generated.push({
      id: `invoice-${invoice.id}`,
      name: `${invoice.invoiceNumber} ${invoice.title}`.trim(),
      category: "invoice",
      detail: formatYen(invoice.total),
      date: invoice.issuedAt ?? invoice.billingDate,
      status: "発行済み",
      tab: "invoices",
    }));
    return generated.sort((a, b) => b.date.localeCompare(a.date));
  }, [estimates, invoices, orders, project]);

  const rows = useMemo(() => {
    const selected = activeVault === "procnova"
      ? vaultDocuments.filter((document) => document.folderId === currentFolderId).map(vaultRow)
      : documents.map(localRow);
    return selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [activeVault, currentFolderId, documents, vaultDocuments]);

  const filteredDocuments = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("ja-JP");
    return rows.filter((document) => {
      if (statusFilter !== "all" && document.status !== statusFilter) return false;
      if (categoryFilter !== "all" && document.category !== categoryFilter) return false;
      if (!keyword) return true;
      return `${document.name} ${document.description} ${document.uploadedByName} ${CATEGORY_LABELS[document.category]}`
        .toLocaleLowerCase("ja-JP")
        .includes(keyword);
    });
  }, [categoryFilter, query, rows, statusFilter]);

  const currentFolder = currentFolderId ? vaultFolders.find((folder) => folder.id === currentFolderId) ?? null : null;
  const visibleFolders = currentFolderId ? [] : vaultFolders;

  const activeDocuments = documents.filter((document) => document.status === "active");
  const archivedDocuments = documents.filter((document) => document.status === "archived");
  const totalSize = activeDocuments.reduce((sum, document) => sum + document.size, 0)
    + vaultDocuments.reduce((sum, document) => sum + document.size, 0);

  function addFiles(files: File[]) {
    const valid: File[] = [];
    const errors: string[] = [];
    files.forEach((file) => {
      const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name);
      const maxMb = activeVault === "procnova" ? (isVideo ? 200 : 50) : 20;
      if (file.size > maxMb * 1024 * 1024) errors.push(`${file.name}（${maxMb}MB超過）`);
      else if (file.size <= 0) errors.push(`${file.name}（空ファイル）`);
      else valid.push(file);
    });
    setSelectedFiles((current) => [...current, ...valid].slice(0, 20));
    setMessage(errors.length > 0 ? `追加できないファイル：${errors.join("、")}` : "");
  }

  async function uploadAll() {
    if (!member) {
      setMessage("ログイン情報を確認できませんでした。ページを再読み込みしてからもう一度お試しください。");
      return;
    }
    if (selectedFiles.length === 0) {
      setMessage("保存するファイルを選択してください。");
      return;
    }
    setBusy("upload");
    setMessage("");
    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        setBusy(`upload-${index + 1}-${selectedFiles.length}`);
        if (activeVault === "procnova") {
          await uploadProcNovaVaultDocument(member, project, selectedFiles[index], uploadCategory, description, currentFolderId, demo);
        } else {
          await uploadProjectDocument(member, project, selectedFiles[index], uploadCategory, description, demo);
        }
      }
      const count = selectedFiles.length;
      setSelectedFiles([]);
      setDescription("");
      await load();
      setMessage(`${count}件の書類を${activeVault === "procnova" ? "ProcNova保管庫" : "ProcMana保管庫"}へアップロードしました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "書類をアップロードできませんでした。");
    } finally {
      setBusy("");
    }
  }

  async function createFolder() {
    if (!member || !linked) return;
    const name = window.prompt("新しいフォルダ名を入力してください。");
    if (name === null || !name.trim()) return;
    setBusy("folder");
    setMessage("");
    try {
      await createProcNovaVaultFolder(member, project, name, demo);
      await load();
      setMessage(`「${name.trim()}」フォルダを作成しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "フォルダを作成できませんでした。");
    } finally {
      setBusy("");
    }
  }

  async function changeStatus(document: ProjectDocument) {
    if (!member) return;
    const next = document.status === "active" ? "archived" : "active";
    if (next === "archived" && !window.confirm(`${document.name}をアーカイブします。ファイルと履歴は削除されません。よろしいですか？`)) return;
    setBusy(document.id);
    setMessage("");
    try {
      await setProjectDocumentStatus(member, project, document.id, next, demo);
      await load();
      setMessage(next === "archived" ? "書類をアーカイブしました。" : "書類を復元しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "書類を更新できませんでした。");
    } finally {
      setBusy("");
    }
  }

  function closeDocumentDialog() {
    if (busy.startsWith("document-")) return;
    setDocumentDialog(null);
    setSelectedDocument(null);
  }

  const updateSelectedCommentCount = useCallback((documentId: string, count: number) => {
    setSelectedDocument((current) => current?.id === documentId ? { ...current, commentCount: count } : current);
    setVaultDocuments((current) => current.map((document) => (
      document.id === documentId
        ? { ...document, commentCount: count }
        : document
    )));
  }, []);

  async function moveInsideProcNova(folderId: string | null) {
    if (!selectedDocument?.vaultDocument) return;
    setBusy(`document-folder-${selectedDocument.id}`);
    setMessage("");
    try {
      await moveProcNovaVaultDocumentToFolder(project, selectedDocument.id, folderId, demo);
      setDocumentDialog(null);
      setSelectedDocument(null);
      setCurrentFolderId(folderId);
      await load();
      setMessage("ProcNova保管庫内でファイルを移動しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "フォルダへ移動できませんでした。");
    } finally {
      setBusy("");
    }
  }

  async function moveBetweenVaults(targetFolderId: string | null = null) {
    if (!member || !selectedDocument) return;
    const destination = selectedDocument.origin === "procnova" ? "ProcMana保管庫" : "ProcNova保管庫";
    if (!window.confirm(`${selectedDocument.name}を${destination}へ移動します。移動完了後、元の保管庫から削除されます。よろしいですか？`)) return;
    setBusy(`document-vault-${selectedDocument.id}`);
    setMessage("");
    try {
      if (selectedDocument.origin === "procnova" && selectedDocument.vaultDocument) {
        await moveProcNovaVaultDocumentToProject(member, project, selectedDocument.vaultDocument, demo);
        setActiveVault("procmana");
        setCurrentFolderId(null);
      } else if (selectedDocument.localDocument) {
        await moveProjectDocumentToProcNova(member, project, selectedDocument.localDocument, targetFolderId, demo);
        setActiveVault("procnova");
        setCurrentFolderId(targetFolderId);
      }
      setDocumentDialog(null);
      setSelectedDocument(null);
      await load();
      setMessage(`${destination}へ移動しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${destination}へ移動できませんでした。`);
    } finally {
      setBusy("");
    }
  }

  async function removeSelectedDocument() {
    if (!member || !selectedDocument) return;
    if (!window.confirm(`${selectedDocument.name}を削除します。この操作は元に戻せません。よろしいですか？`)) return;
    setBusy(`document-delete-${selectedDocument.id}`);
    setMessage("");
    try {
      if (selectedDocument.origin === "procnova" && selectedDocument.vaultDocument) {
        await deleteProcNovaVaultDocument(member, project, selectedDocument.vaultDocument, demo);
      } else if (selectedDocument.localDocument) {
        await deleteProjectDocument(member, project, selectedDocument.localDocument, demo);
      }
      setDocumentDialog(null);
      setSelectedDocument(null);
      await load();
      setMessage("ファイルを削除しました。操作履歴は保持されています。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ファイルを削除できませんでした。");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return <div className="pm-card grid min-h-80 place-items-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-blue-700 border-t-transparent" /></div>;
  }

  return <div className="space-y-6">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="pm-card border-blue-100 bg-blue-50/70">
        <p className="text-xs font-semibold text-blue-700">ProcNova保管庫</p>
        <p className="mt-3 text-2xl font-bold tabular-nums text-blue-900">{linked ? `${vaultDocuments.length}件` : "未連携"}</p>
        <p className="mt-1 text-xs text-blue-600">現場と同じファイルを直接参照</p>
      </div>
      <div className="pm-card">
        <p className="text-xs font-semibold text-slate-500">ProcMana専用</p>
        <p className="mt-3 text-2xl font-bold tabular-nums">{activeDocuments.length}件</p>
        <p className="mt-1 text-xs text-slate-400">経営側だけで保管</p>
      </div>
      <div className="pm-card">
        <p className="text-xs font-semibold text-slate-500">使用容量</p>
        <p className="mt-3 text-2xl font-bold tabular-nums">{sizeLabel(totalSize)}</p>
        <p className="mt-1 text-xs text-slate-400">両保管領域の表示対象</p>
      </div>
      <div className="pm-card">
        <p className="text-xs font-semibold text-slate-500">業務書類</p>
        <p className="mt-3 text-2xl font-bold tabular-nums">{generatedDocuments.length}件</p>
        <p className="mt-1 text-xs text-slate-400">見積・契約・発注・請求</p>
      </div>
    </section>

    {linked && <section className="pm-card border-blue-100 bg-blue-50/50">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-100 text-blue-800"><Link2 size={19} /></span>
          <div><h2 className="font-bold text-blue-950">ProcNova保管庫と接続中</h2><p className="mt-1 text-sm text-blue-800">ここから追加した現場共有書類は、ProcNovaの保管庫にも即時表示されます。ファイルは複製しません。</p></div>
        </div>
        <a className="pm-secondary shrink-0 bg-white" href={procNovaDocumentsUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />ProcNova保管庫を開く</a>
      </div>
    </section>}

    <section className="pm-card overflow-hidden p-0">
      <div className="flex flex-col gap-4 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div><h2 className="font-bold">業務書類</h2><p className="mt-1 text-xs text-slate-500">各業務タブで作成した帳票をまとめて確認できます。</p></div>
        <span className="text-xs font-semibold text-slate-400">帳票出力は各業務ページから行います</span>
      </div>
      {generatedDocuments.length === 0
        ? <div className="grid min-h-40 place-items-center p-6 text-sm text-slate-400">見積・契約・発注・請求の書類はまだありません。</div>
        : <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">{generatedDocuments.map((document) => <Link key={document.id} href={`?tab=${document.tab}`} className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md">
          <div className="flex items-start gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${CATEGORY_STYLES[document.category]}`}><FileText size={19} /></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY_STYLES[document.category]}`}>{CATEGORY_LABELS[document.category]}</span><span className="text-[10px] font-semibold text-slate-400">{document.status}</span></div><p className="mt-2 truncate font-bold text-slate-800 group-hover:text-blue-800">{document.name}</p><div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400"><span>{dateLabel(document.date)}</span><span className="font-semibold tabular-nums text-slate-600">{document.detail}</span></div></div></div>
        </Link>)}</div>}
    </section>

    <section className="pm-card overflow-hidden p-0">
      <div className="grid gap-2 border-b border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={!linked}
          onClick={() => {
            setActiveVault("procnova");
            setCurrentFolderId(null);
            setStatusFilter("active");
            setSelectedFiles([]);
            setMessage("");
          }}
          className={`rounded-xl border p-4 text-left transition ${activeVault === "procnova" ? "border-blue-500 bg-white shadow-sm ring-2 ring-blue-100" : "border-transparent hover:bg-white"} ${!linked ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-bold text-blue-950"><Link2 size={18} />ProcNova保管庫</span>
            <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">{vaultDocuments.length}件</span>
          </span>
          <span className="mt-1 block text-xs text-slate-500">現場管理で共有する図面・写真・報告書</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveVault("procmana");
            setCurrentFolderId(null);
            setSelectedFiles([]);
            setMessage("");
          }}
          className={`rounded-xl border p-4 text-left transition ${activeVault === "procmana" ? "border-slate-500 bg-white shadow-sm ring-2 ring-slate-200" : "border-transparent hover:bg-white"}`}
        >
          <span className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-bold text-slate-900"><FolderArchive size={18} />ProcMana保管庫</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-bold text-slate-700">{documents.length}件</span>
          </span>
          <span className="mt-1 block text-xs text-slate-500">経営管理権限だけで扱う契約・経営資料</span>
        </button>
      </div>

      <div className="p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-950">保管庫</h2>
            <p className="mt-1 text-sm text-slate-500">工事：{project.name}</p>
          </div>
          {activeVault === "procnova" && linked && <a className="pm-secondary shrink-0" href={procNovaDocumentsUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />ProcNovaで開く</a>}
        </div>

        {canEdit && <>
          <button
            type="button"
            className={`mt-7 grid min-h-56 w-full place-items-center rounded-2xl border-2 border-dashed bg-white p-7 text-center transition ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 hover:border-blue-400 hover:bg-blue-50/30"}`}
            disabled={activeVault === "procnova" && !linked}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }}
          >
            <span>
              <UploadCloud size={42} strokeWidth={1.8} className="mx-auto text-slate-400" />
              <span className="mt-4 block text-base font-bold text-slate-800">クリックまたはドラッグ＆ドロップでファイルを追加</span>
              {activeVault === "procnova"
                ? <><span className="mt-3 block text-sm text-slate-500">PDF・Excel・Word・PowerPoint・CSV・テキスト・画像は50MBまで</span><span className="mt-2 block text-sm text-slate-500">動画（mp4・mov・webm）は200MBまで</span></>
                : <span className="mt-3 block text-sm text-slate-500">ProcMana専用書類は1ファイル20MBまで・最大20件</span>}
              {activeVault === "procnova" && currentFolder && <span className="mt-3 inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">保存先：{currentFolder.name}</span>}
            </span>
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt,.zip,.mp4,.mov,.webm" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
        </>}

        {selectedFiles.length > 0 && <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-500">選択中 {selectedFiles.length}件</p>
              {selectedFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-3 rounded-xl bg-white px-3 py-2 text-sm shadow-sm">
                <span className="text-blue-700">{fileIcon(file.type, file.name)}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{file.name}</span>
                <span className="text-xs text-slate-400">{sizeLabel(file.size)}</span>
                <button type="button" aria-label={`${file.name}を選択から外す`} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setSelectedFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}><X size={15} /></button>
              </div>)}
            </div>
            <div className="space-y-3">
              <label className="block text-sm font-semibold">分類<select className="pm-input mt-2 bg-white" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value as ProjectDocumentCategory)}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="block text-sm font-semibold">共通説明<textarea rows={2} className="pm-input mt-2 resize-y bg-white" value={description} placeholder="任意" onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="pm-secondary" disabled={busy !== ""} onClick={() => setSelectedFiles([])}>キャンセル</button>
            <button type="button" className="pm-primary min-w-44" disabled={busy !== "" || selectedFiles.length === 0 || (activeVault === "procnova" && !linked)} onClick={() => void uploadAll()}>{busy.startsWith("upload") ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />{busy === "upload" ? "準備中…" : `${busy.split("-")[1]}/${busy.split("-")[2]} アップロード中`}</> : <><UploadCloud size={16} />保管庫へ追加</>}</button>
          </div>
        </div>}

        {message && <p role="status" className={`mt-4 rounded-xl p-4 text-sm font-semibold ${message.includes("できません") || message.includes("超過") || message.includes("確認できません") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}

        <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            {activeVault === "procnova" && currentFolder && <button type="button" className="pm-secondary" onClick={() => setCurrentFolderId(null)}><ArrowLeft size={15} />保管庫トップ</button>}
            <h3 className="font-bold text-slate-800">{currentFolder ? currentFolder.name : activeVault === "procnova" ? "ProcNova保管庫" : "ProcMana保管庫"}</h3>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <label className="relative min-w-56 flex-1"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className="pm-input pl-9" value={query} placeholder="ファイル名・説明で検索" onChange={(event) => setQuery(event.target.value)} /></label>
            <select className="pm-input sm:w-36" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as "all" | ProjectDocumentCategory)}><option value="all">全分類</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {activeVault === "procmana" && <select className="pm-input sm:w-36" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "active" | "archived" | "all")}><option value="active">保管中</option><option value="archived">アーカイブ</option><option value="all">すべて</option></select>}
          </div>
        </div>

        {activeVault === "procnova" && !currentFolderId && <div className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-lg font-bold text-slate-800">フォルダ</h3>
            {canEdit && <button type="button" className="pm-secondary" disabled={busy !== "" || !linked} onClick={() => void createFolder()}>{busy === "folder" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <FolderPlus size={16} />}新しいフォルダ</button>}
          </div>
          {visibleFolders.length === 0
            ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-400">フォルダはまだありません。</p>
            : <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{visibleFolders.map((folder) => {
              const fileCount = vaultDocuments.filter((document) => document.folderId === folder.id).length;
              return <button key={folder.id} type="button" className="group overflow-hidden rounded-2xl border border-slate-200 bg-white text-left transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md" onClick={() => setCurrentFolderId(folder.id)}>
                <span className="grid aspect-[1.45/1] place-items-center bg-amber-50 text-amber-500"><Folder size={42} strokeWidth={1.8} /></span>
                <span className="block px-3 py-2.5"><span className="block truncate text-sm font-bold text-slate-800 group-hover:text-amber-800">{folder.name}</span><span className="mt-0.5 block text-[11px] text-slate-400">{fileCount}件・追加: {folder.createdByName || "—"}</span></span>
              </button>;
            })}</div>}
        </div>}

        <div className="mt-8">
          <h3 className="text-lg font-bold text-slate-800">ファイル</h3>
          {activeVault === "procnova" && vaultError
            ? <div className="mt-4 rounded-2xl bg-red-50 p-6 text-center"><p className="text-sm font-bold text-red-700">ProcNova保管庫を読み込めませんでした</p><p className="mt-2 text-xs text-red-600">{vaultError}</p><button type="button" className="pm-secondary mt-4 bg-white" onClick={() => void load()}>再読み込み</button></div>
            : filteredDocuments.length === 0
              ? <div className="mt-4 grid min-h-36 place-items-center rounded-2xl bg-slate-50 p-6 text-center"><div><FolderArchive size={34} className="mx-auto text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">この場所に表示できるファイルはありません</p></div></div>
              : <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{filteredDocuments.map((document) => <button key={document.key} type="button" title="クリックでプレビュー・右クリックで操作" className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-white text-left transition hover:-translate-y-0.5 hover:shadow-md ${document.status === "archived" ? "opacity-60" : ""}`} onClick={() => { setSelectedDocument(document); setDocumentDialog("preview"); }} onContextMenu={(event) => { event.preventDefault(); setSelectedDocument(document); setDocumentDialog("menu"); }}>
                  <span className={`relative grid aspect-[1.45/1] place-items-center overflow-hidden ${fileCardStyle(document.contentType, document.name)}`}>
                    {isImageFile(document.contentType, document.name) && document.fileUrl
                      ? <img src={document.fileUrl} alt="" className="h-full w-full object-cover" />
                      : <span className="[&>svg]:h-9 [&>svg]:w-9">{fileIcon(document.contentType, document.name)}</span>}
                    {document.commentCount > 0 && <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-2 py-1 text-[10px] font-bold text-white"><MessageCircle size={11} />{document.commentCount}</span>}
                  </span>
                  <span className="block px-3 py-2.5"><span className="block truncate text-sm font-bold text-slate-800 group-hover:text-blue-800">{document.name}</span><span className="mt-0.5 block text-[11px] text-slate-400">{sizeLabel(document.size)}</span><span className="mt-0.5 block truncate text-[11px] text-slate-400">追加: {document.uploadedByName || "—"}</span></span>
              </button>)}</div>}
        </div>
      </div>
    </section>

    {selectedDocument && documentDialog === "preview" && <DocumentPreviewModal document={selectedDocument} project={project} member={member} onClose={closeDocumentDialog} onCountChange={updateSelectedCommentCount} />}

    {selectedDocument && documentDialog && documentDialog !== "preview" && <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDocumentDialog(); }}>
      <div role="dialog" aria-modal="true" aria-label={`${selectedDocument.name}の操作`} className="w-full max-w-md overflow-hidden rounded-[28px] bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl ${fileCardStyle(selectedDocument.contentType, selectedDocument.name)} [&>svg]:h-7 [&>svg]:w-7`}>{fileIcon(selectedDocument.contentType, selectedDocument.name)}</span>
          <div className="min-w-0 flex-1"><p className="truncate font-bold text-slate-900">{selectedDocument.name}</p><p className="mt-1 text-sm text-slate-500">{sizeLabel(selectedDocument.size)}・{selectedDocument.origin === "procnova" ? "ProcNova保管庫" : "ProcMana保管庫"}</p></div>
          <button type="button" aria-label="閉じる" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-50 text-slate-500 hover:bg-slate-100" disabled={busy.startsWith("document-")} onClick={closeDocumentDialog}><X size={20} /></button>
        </div>

        {busy.startsWith("document-") && <div className="mt-6 flex items-center justify-center gap-3 rounded-2xl bg-blue-50 p-5 text-sm font-bold text-blue-800"><span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />処理しています…</div>}

        {!busy.startsWith("document-") && documentDialog === "menu" && <div className="mt-6 space-y-2">
          <button type="button" className="flex w-full items-center gap-3 rounded-2xl bg-slate-50 px-4 py-4 text-left font-bold text-slate-800 hover:bg-blue-50 hover:text-blue-800" onClick={() => setDocumentDialog("preview")}><ZoomIn size={21} />プレビュー</button>
          {selectedDocument.fileUrl && <a href={selectedDocument.fileUrl} download={selectedDocument.name} className="flex w-full items-center gap-3 rounded-2xl px-4 py-4 font-bold text-slate-800 hover:bg-slate-50"><Download size={21} />ダウンロード</a>}
          {selectedDocument.origin === "procnova" && (project.siteRole === "owner" || project.siteRole === "admin") && <button type="button" className="flex w-full items-center gap-3 rounded-2xl px-4 py-4 text-left font-bold text-slate-800 hover:bg-slate-50" onClick={() => setDocumentDialog("folder")}><FolderInput size={21} />フォルダへ移動</button>}
          {canEdit && linked && (selectedDocument.origin === "procmana" || project.siteRole === "owner" || project.siteRole === "admin") && <button type="button" className="flex w-full items-center gap-3 rounded-2xl px-4 py-4 text-left font-bold text-blue-800 hover:bg-blue-50" onClick={() => setDocumentDialog("vault")}><MoveRight size={21} />{selectedDocument.origin === "procnova" ? "ProcMana保管庫へ移動" : "ProcNova保管庫へ移動"}</button>}
          {canEdit && selectedDocument.localDocument && <button type="button" className="flex w-full items-center gap-3 rounded-2xl px-4 py-4 text-left font-bold text-slate-700 hover:bg-slate-50" onClick={() => { void changeStatus(selectedDocument.localDocument!); setDocumentDialog(null); setSelectedDocument(null); }}>{selectedDocument.status === "active" ? <Archive size={21} /> : <ArchiveRestore size={21} />}{selectedDocument.status === "active" ? "アーカイブ" : "アーカイブから復元"}</button>}
          {canEdit && (selectedDocument.origin === "procmana" || project.siteRole === "owner" || project.siteRole === "admin") && <button type="button" className="flex w-full items-center gap-3 rounded-2xl px-4 py-4 text-left font-bold text-red-600 hover:bg-red-50" onClick={() => void removeSelectedDocument()}><Trash2 size={21} />削除</button>}
        </div>}

        {!busy.startsWith("document-") && documentDialog === "folder" && <div className="mt-6">
          <div className="mb-3 flex items-center gap-2"><button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" onClick={() => setDocumentDialog("menu")}><ArrowLeft size={18} /></button><h3 className="font-bold">移動先フォルダ</h3></div>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            <button type="button" className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left font-semibold ${selectedDocument.folderId === null ? "border-blue-300 bg-blue-50 text-blue-800" : "border-slate-200 hover:bg-slate-50"}`} onClick={() => void moveInsideProcNova(null)}><FolderArchive size={18} />保管庫トップ</button>
            {vaultFolders.map((folder) => <button key={folder.id} type="button" className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left font-semibold ${selectedDocument.folderId === folder.id ? "border-blue-300 bg-blue-50 text-blue-800" : "border-slate-200 hover:bg-slate-50"}`} onClick={() => void moveInsideProcNova(folder.id)}><Folder size={18} className="text-amber-500" /><span className="min-w-0 flex-1 truncate">{folder.name}</span></button>)}
          </div>
        </div>}

        {!busy.startsWith("document-") && documentDialog === "vault" && <div className="mt-6">
          <div className="mb-3 flex items-center gap-2"><button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" onClick={() => setDocumentDialog("menu")}><ArrowLeft size={18} /></button><h3 className="font-bold">保管庫の移動先</h3></div>
          {selectedDocument.origin === "procnova"
            ? <button type="button" className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 px-4 py-4 text-left font-bold hover:border-blue-300 hover:bg-blue-50" onClick={() => void moveBetweenVaults()}><FolderArchive size={22} className="text-blue-700" /><span><span className="block">ProcMana保管庫</span><span className="mt-1 block text-xs font-normal text-slate-500">経営管理権限だけで扱う保管庫へ移動</span></span></button>
            : <div className="max-h-72 space-y-2 overflow-y-auto">
              <button type="button" className="flex w-full items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-left font-semibold hover:border-blue-300 hover:bg-blue-50" onClick={() => void moveBetweenVaults(null)}><FolderArchive size={18} className="text-blue-700" />ProcNova保管庫トップ</button>
              {vaultFolders.map((folder) => <button key={folder.id} type="button" className="flex w-full items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-left font-semibold hover:border-blue-300 hover:bg-blue-50" onClick={() => void moveBetweenVaults(folder.id)}><Folder size={18} className="text-amber-500" /><span className="min-w-0 flex-1 truncate">{folder.name}</span></button>)}
            </div>}
        </div>}
      </div>
    </div>}

    {false && <section className="pm-card overflow-hidden p-0">
      <div className="grid gap-2 border-b border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={!linked}
          onClick={() => {
            setActiveVault("procnova");
            setStatusFilter("active");
            setShowUpload(false);
            setSelectedFiles([]);
            setMessage("");
          }}
          className={`rounded-xl border p-4 text-left transition ${activeVault === "procnova" ? "border-blue-500 bg-white shadow-sm ring-2 ring-blue-100" : "border-transparent bg-transparent hover:bg-white"} ${!linked ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 font-bold text-blue-900"><Link2 size={18} />ProcNova保管庫</span><span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">{vaultDocuments.length}件</span></span>
          <span className="mt-1 block text-xs text-slate-500">現場管理で共有する図面・写真・報告書</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveVault("procmana");
            setShowUpload(false);
            setSelectedFiles([]);
            setMessage("");
          }}
          className={`rounded-xl border p-4 text-left transition ${activeVault === "procmana" ? "border-slate-500 bg-white shadow-sm ring-2 ring-slate-200" : "border-transparent bg-transparent hover:bg-white"}`}
        >
          <span className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 font-bold text-slate-800"><FolderArchive size={18} />ProcMana保管庫</span><span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-bold text-slate-700">{documents.length}件</span></span>
          <span className="mt-1 block text-xs text-slate-500">経営管理権限だけで扱う契約・経営資料</span>
        </button>
      </div>
      <div className="border-b border-slate-200 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div><h2 className="font-bold">{activeVault === "procnova" ? "ProcNova保管庫の書類" : "ProcMana保管庫の書類"}</h2><p className="mt-1 text-xs text-slate-500">{activeVault === "procnova" ? "ProcNovaで登録済みの書類を直接表示します。ここで追加した書類もProcNovaへ即時反映されます。" : "経営管理側だけで保管する書類です。ProcNovaの現場メンバーには表示されません。"}</p></div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <label className="relative min-w-56 flex-1"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className="pm-input pl-9" value={query} placeholder="ファイル名・説明で検索" onChange={(event) => setQuery(event.target.value)} /></label>
            <select className="pm-input sm:w-36" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as "all" | ProjectDocumentCategory)}><option value="all">全分類</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {activeVault === "procmana" && <select className="pm-input sm:w-36" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "active" | "archived" | "all")}><option value="active">保管中</option><option value="archived">アーカイブ</option><option value="all">すべて</option></select>}
            {activeVault === "procnova" && linked && <a className="pm-secondary whitespace-nowrap" href={procNovaDocumentsUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />ProcNovaで開く</a>}
            {canEdit && <button type="button" className="pm-primary whitespace-nowrap" disabled={activeVault === "procnova" && !linked} onClick={() => setShowUpload((current) => !current)}><Plus size={16} />この保管庫へ追加</button>}
          </div>
        </div>

        {showUpload && <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
          <p className="mb-4 flex items-center gap-2 text-sm font-bold text-blue-900">{activeVault === "procnova" ? <Link2 size={16} /> : <FolderArchive size={16} />}{activeVault === "procnova" ? "ProcNova保管庫へ追加" : "ProcMana保管庫へ追加"}</p>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <button type="button" className={`grid min-h-36 place-items-center rounded-xl border-2 border-dashed bg-white p-5 text-center transition ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:border-blue-300"}`} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }}><span><UploadCloud size={30} className="mx-auto text-blue-700" /><span className="mt-2 block text-sm font-bold">ファイルを選択またはドロップ</span><span className="mt-1 block text-xs text-slate-400">1ファイル20MBまで・最大20件</span></span></button>
            <div className="space-y-3"><label className="block text-sm font-semibold">分類<select className="pm-input mt-2 bg-white" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value as ProjectDocumentCategory)}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm font-semibold">共通説明<textarea rows={2} className="pm-input mt-2 resize-y bg-white" value={description} placeholder="任意" onChange={(event) => setDescription(event.target.value)} /></label></div>
          </div>
          <input ref={inputRef} type="file" multiple className="hidden" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt,.zip" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
          {selectedFiles.length > 0 && <div className="mt-4 space-y-2"><p className="text-xs font-bold text-slate-500">選択中 {selectedFiles.length}件</p>{selectedFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm"><span className="text-blue-700">{fileIcon(file.type, file.name)}</span><span className="min-w-0 flex-1 truncate font-semibold">{file.name}</span><span className="text-xs text-slate-400">{sizeLabel(file.size)}</span><button type="button" aria-label={`${file.name}を選択から外す`} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setSelectedFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}><X size={15} /></button></div>)}</div>}
          <div className="mt-4 flex justify-end gap-2"><button type="button" className="pm-secondary" disabled={busy !== ""} onClick={() => { setSelectedFiles([]); setShowUpload(false); }}>キャンセル</button><button type="button" className="pm-primary min-w-40" disabled={busy !== "" || selectedFiles.length === 0 || (activeVault === "procnova" && !linked)} onClick={() => void uploadAll()}>{busy.startsWith("upload") ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />{busy === "upload" ? "準備中…" : `${busy.split("-")[1]}/${busy.split("-")[2]} アップロード中`}</> : <><UploadCloud size={16} />保管庫へ追加</>}</button></div>
        </div>}
      </div>

      {activeVault === "procnova" && vaultError
        ? <div className="grid min-h-52 place-items-center p-6 text-center"><div><FolderArchive size={34} className="mx-auto text-red-300" /><p className="mt-3 text-sm font-bold text-red-700">ProcNova保管庫を読み込めませんでした</p><p className="mt-2 max-w-xl text-xs text-red-600">{vaultError}</p><button type="button" className="pm-secondary mt-4" onClick={() => void load()}>再読み込み</button></div></div>
        : filteredDocuments.length === 0
          ? <div className="grid min-h-52 place-items-center p-6 text-center"><div><FolderArchive size={34} className="mx-auto text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">{activeVault === "procnova" ? "ProcNova保管庫に表示できる書類はありません" : "条件に一致するProcMana書類はありません"}</p></div></div>
          : <div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">書類名</th><th className="px-4 py-3 text-left">分類</th><th className="px-4 py-3 text-left">説明</th><th className="px-4 py-3 text-left">登録者・日時</th><th className="px-4 py-3 text-right">サイズ</th><th className="px-4 py-3 text-center">状態</th><th className="px-4 py-3 text-center">操作</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredDocuments.map((document) => <tr key={document.key} className={document.status === "archived" ? "bg-slate-50 text-slate-400" : "hover:bg-slate-50/60"}>
          <td className="px-4 py-4"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${document.status === "archived" ? "bg-slate-100 text-slate-400" : "bg-blue-50 text-blue-700"}`}>{fileIcon(document.contentType, document.name)}</span><div className="min-w-0"><p className="max-w-72 truncate font-bold">{document.name}</p><p className="mt-1 text-[10px] text-slate-400">{document.contentType || "ファイル"}</p></div></div></td>
          <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${CATEGORY_STYLES[document.category]}`}>{CATEGORY_LABELS[document.category]}</span></td>
          <td className="max-w-72 whitespace-pre-wrap px-4 py-4 text-slate-500">{document.description || "—"}</td>
          <td className="px-4 py-4"><p className="font-semibold">{document.uploadedByName || "—"}</p><p className="mt-1 text-xs text-slate-400">{dateLabel(document.createdAt)}</p></td>
          <td className="px-4 py-4 text-right tabular-nums">{sizeLabel(document.size)}</td>
          <td className="px-4 py-4 text-center"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${document.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{document.status === "active" ? (activeVault === "procnova" ? "現場共有中" : "保管中") : "アーカイブ"}</span></td>
          <td className="px-4 py-4"><div className="flex justify-center gap-2">{document.fileUrl && <a className="pm-secondary" href={document.fileUrl} target="_blank" rel="noopener noreferrer"><Download size={14} />開く</a>}{document.origin === "procnova" && <a aria-label="ProcNova保管庫で表示" title="ProcNova保管庫で表示" className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 text-blue-700 hover:bg-blue-50" href={procNovaDocumentsUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /></a>}{canEdit && document.localDocument && <button type="button" aria-label={document.status === "active" ? "アーカイブ" : "復元"} title={document.status === "active" ? "アーカイブ" : "復元"} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" disabled={busy !== ""} onClick={() => void changeStatus(document.localDocument!)}>{document.status === "active" ? <Archive size={15} /> : <ArchiveRestore size={15} />}</button>}</div></td>
        </tr>)}</tbody></table></div>}
    </section>}

    {archivedDocuments.length > 0 && <p className="text-right text-xs text-slate-400">ProcManaアーカイブ：{archivedDocuments.length}件（削除せず履歴保持）</p>}
    {message && <p role="status" className={`rounded-xl p-4 text-sm ${message.includes("できません") || message.includes("超過") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}
  </div>;
}
