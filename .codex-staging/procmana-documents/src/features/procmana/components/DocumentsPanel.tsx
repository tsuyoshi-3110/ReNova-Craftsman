"use client";

import { Archive, ArchiveRestore, Download, File, FileImage, FileSpreadsheet, FileText, FolderArchive, Plus, Search, UploadCloud, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatYen } from "../calculations";
import { listInvoices, listProjectDocuments, listPurchaseOrders, setProjectDocumentStatus, uploadProjectDocument } from "../services/repository";
import type { Estimate, Invoice, Project, ProjectDocument, ProjectDocumentCategory, PurchaseOrder } from "../types";
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

const CATEGORY_LABELS: Record<ProjectDocumentCategory, string> = {
  estimate: "見積",
  contract: "契約",
  order: "発注",
  invoice: "請求",
  drawing: "図面",
  report: "報告書",
  permit: "申請・許可",
  photo: "写真",
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
  other: "bg-slate-100 text-slate-600",
};

function dateLabel(value: string): string { return value ? value.slice(0, 10).replaceAll("-", "/") : "—"; }
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`;
}
function fileIcon(contentType: string, name: string) {
  const value = `${contentType} ${name}`.toLowerCase();
  if (value.includes("image") || /\.(jpe?g|png|gif|webp|heic)$/.test(value)) return <FileImage size={20} />;
  if (value.includes("spreadsheet") || value.includes("excel") || /\.(xlsx?|csv)$/.test(value)) return <FileSpreadsheet size={20} />;
  if (value.includes("pdf") || value.includes("word") || /\.(pdf|docx?)$/.test(value)) return <FileText size={20} />;
  return <File size={20} />;
}

export function DocumentsPanel({ project, estimates, canEdit, demo }: Props) {
  const { member } = useProcManaSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | ProjectDocumentCategory>("all");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<ProjectDocumentCategory>("other");
  const [description, setDescription] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const [nextDocuments, nextOrders, nextInvoices] = await Promise.all([
      listProjectDocuments(project.id, demo), listPurchaseOrders(project.id, demo), listInvoices(project.id, demo),
    ]);
    setDocuments(nextDocuments);
    setOrders(nextOrders);
    setInvoices(nextInvoices);
  }

  useEffect(() => {
    let active = true;
    Promise.all([listProjectDocuments(project.id, demo), listPurchaseOrders(project.id, demo), listInvoices(project.id, demo)])
      .then(([nextDocuments, nextOrders, nextInvoices]) => {
        if (!active) return;
        setDocuments(nextDocuments); setOrders(nextOrders); setInvoices(nextInvoices);
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "書類を読み込めませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demo, project.id]);

  const generatedDocuments = useMemo<GeneratedDocument[]>(() => {
    const generated: GeneratedDocument[] = estimates.map((estimate) => ({
      id: `estimate-${estimate.id}`, name: `${estimate.estimateNumber} ${estimate.subject}`.trim(), category: "estimate",
      detail: formatYen(estimate.total), date: estimate.updatedAt || estimate.estimateDate,
      status: estimate.status === "adopted" ? "契約採用" : estimate.status === "submitted" ? "提出済み" : "下書き", tab: "estimate",
    }));
    if (project.activeContractId || project.lastContractId) generated.push({
      id: `contract-${project.activeContractId ?? project.lastContractId}`, name: `${project.name} 契約書`, category: "contract",
      detail: formatYen(project.contractAmount), date: project.contractConfirmedAt ?? project.contractCancelledAt ?? "",
      status: project.contractState === "active" ? "契約中" : "解除済み", tab: "contract",
    });
    orders.filter((order) => order.status !== "draft").forEach((order) => generated.push({
      id: `order-${order.id}`, name: `${order.orderNumber} ${order.vendorName}`.trim(), category: "order",
      detail: formatYen(order.total), date: order.confirmedAt ?? order.orderDate,
      status: order.status === "confirmed" ? "確定" : "取消済み", tab: "orders",
    }));
    invoices.filter((invoice) => invoice.status === "issued").forEach((invoice) => generated.push({
      id: `invoice-${invoice.id}`, name: `${invoice.invoiceNumber} ${invoice.title}`.trim(), category: "invoice",
      detail: formatYen(invoice.total), date: invoice.issuedAt ?? invoice.billingDate,
      status: "発行済み", tab: "invoices",
    }));
    return generated.sort((a, b) => b.date.localeCompare(a.date));
  }, [estimates, invoices, orders, project]);

  const filteredDocuments = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("ja-JP");
    return documents.filter((document) => {
      if (statusFilter !== "all" && document.status !== statusFilter) return false;
      if (categoryFilter !== "all" && document.category !== categoryFilter) return false;
      if (!keyword) return true;
      return `${document.name} ${document.description} ${document.uploadedByName} ${CATEGORY_LABELS[document.category]}`.toLocaleLowerCase("ja-JP").includes(keyword);
    });
  }, [categoryFilter, documents, query, statusFilter]);

  const activeDocuments = documents.filter((document) => document.status === "active");
  const archivedDocuments = documents.filter((document) => document.status === "archived");
  const totalSize = activeDocuments.reduce((sum, document) => sum + document.size, 0);

  function addFiles(files: File[]) {
    const valid: File[] = [];
    const errors: string[] = [];
    files.forEach((file) => {
      if (file.size > 20 * 1024 * 1024) errors.push(`${file.name}（20MB超過）`);
      else if (file.size <= 0) errors.push(`${file.name}（空ファイル）`);
      else valid.push(file);
    });
    setSelectedFiles((current) => [...current, ...valid].slice(0, 20));
    setMessage(errors.length > 0 ? `追加できないファイル：${errors.join("、")}` : "");
  }

  async function uploadAll() {
    if (!member || selectedFiles.length === 0) return;
    setBusy("upload"); setMessage("");
    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        setBusy(`upload-${index + 1}-${selectedFiles.length}`);
        await uploadProjectDocument(member, project, selectedFiles[index], uploadCategory, description, demo);
      }
      const count = selectedFiles.length;
      setSelectedFiles([]); setDescription(""); setShowUpload(false);
      await load();
      setMessage(`${count}件の書類をアップロードしました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "書類をアップロードできませんでした。");
    } finally { setBusy(""); }
  }

  async function changeStatus(document: ProjectDocument) {
    if (!member) return;
    const next = document.status === "active" ? "archived" : "active";
    if (next === "archived" && !window.confirm(`${document.name}をアーカイブします。ファイルと履歴は削除されません。よろしいですか？`)) return;
    setBusy(document.id); setMessage("");
    try {
      await setProjectDocumentStatus(member, project, document.id, next, demo);
      await load();
      setMessage(next === "archived" ? "書類をアーカイブしました。" : "書類を復元しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "書類を更新できませんでした。");
    } finally { setBusy(""); }
  }

  if (loading) return <div className="pm-card grid min-h-80 place-items-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-blue-700 border-t-transparent" /></div>;

  return <div className="space-y-6">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="pm-card"><p className="text-xs font-semibold text-slate-500">保管中の書類</p><p className="mt-3 text-2xl font-bold tabular-nums">{activeDocuments.length}件</p><p className="mt-1 text-xs text-slate-400">アップロード済み</p></div>
      <div className="pm-card bg-blue-50/70"><p className="text-xs font-semibold text-blue-700">業務書類</p><p className="mt-3 text-2xl font-bold tabular-nums text-blue-900">{generatedDocuments.length}件</p><p className="mt-1 text-xs text-blue-600">見積・契約・発注・請求</p></div>
      <div className="pm-card"><p className="text-xs font-semibold text-slate-500">使用容量</p><p className="mt-3 text-2xl font-bold tabular-nums">{sizeLabel(totalSize)}</p><p className="mt-1 text-xs text-slate-400">有効な書類の合計</p></div>
      <div className="pm-card"><p className="text-xs font-semibold text-slate-500">アーカイブ</p><p className="mt-3 text-2xl font-bold tabular-nums">{archivedDocuments.length}件</p><p className="mt-1 text-xs text-slate-400">削除せず履歴保持</p></div>
    </section>

    <section className="pm-card overflow-hidden p-0">
      <div className="flex flex-col gap-4 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="font-bold">業務書類</h2><p className="mt-1 text-xs text-slate-500">各業務タブで作成した帳票をまとめて確認できます。</p></div><span className="text-xs font-semibold text-slate-400">帳票出力は各業務ページから行います</span></div>
      {generatedDocuments.length === 0 ? <div className="grid min-h-40 place-items-center p-6 text-sm text-slate-400">見積・契約・発注・請求の書類はまだありません。</div> : <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">{generatedDocuments.map((document) => <Link key={document.id} href={`?tab=${document.tab}`} className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"><div className="flex items-start gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${CATEGORY_STYLES[document.category]}`}><FileText size={19} /></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY_STYLES[document.category]}`}>{CATEGORY_LABELS[document.category]}</span><span className="text-[10px] font-semibold text-slate-400">{document.status}</span></div><p className="mt-2 truncate font-bold text-slate-800 group-hover:text-blue-800">{document.name}</p><div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400"><span>{dateLabel(document.date)}</span><span className="font-semibold tabular-nums text-slate-600">{document.detail}</span></div></div></div></Link>)}</div>}
    </section>

    <section className="pm-card overflow-hidden p-0">
      <div className="border-b border-slate-200 p-5"><div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"><div><h2 className="font-bold">添付書類</h2><p className="mt-1 text-xs text-slate-500">図面・許可書・報告書など、工事に関係するファイルを保管します。</p></div><div className="flex flex-col gap-2 sm:flex-row"><label className="relative min-w-64"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className="pm-input pl-9" value={query} placeholder="ファイル名・説明で検索" onChange={(event) => setQuery(event.target.value)} /></label><select className="pm-input sm:w-36" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as "all" | ProjectDocumentCategory)}><option value="all">全分類</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="pm-input sm:w-36" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "active" | "archived" | "all")}><option value="active">保管中</option><option value="archived">アーカイブ</option><option value="all">すべて</option></select>{canEdit && <button type="button" className="pm-primary whitespace-nowrap" onClick={() => setShowUpload((current) => !current)}><Plus size={16} />書類を追加</button>}</div></div>
        {showUpload && <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/40 p-4"><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]"><button type="button" className={`grid min-h-36 place-items-center rounded-xl border-2 border-dashed bg-white p-5 text-center transition ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:border-blue-300"}`} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }}><span><UploadCloud size={30} className="mx-auto text-blue-700" /><span className="mt-2 block text-sm font-bold">ファイルを選択またはドロップ</span><span className="mt-1 block text-xs text-slate-400">1ファイル20MBまで・最大20件</span></span></button><div className="space-y-3"><label className="block text-sm font-semibold">分類<select className="pm-input mt-2 bg-white" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value as ProjectDocumentCategory)}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm font-semibold">共通説明<textarea rows={2} className="pm-input mt-2 resize-y bg-white" value={description} placeholder="任意" onChange={(event) => setDescription(event.target.value)} /></label></div></div><input ref={inputRef} type="file" multiple className="hidden" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt,.zip" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />{selectedFiles.length > 0 && <div className="mt-4 space-y-2"><p className="text-xs font-bold text-slate-500">選択中 {selectedFiles.length}件</p>{selectedFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm"><span className="text-blue-700">{fileIcon(file.type, file.name)}</span><span className="min-w-0 flex-1 truncate font-semibold">{file.name}</span><span className="text-xs text-slate-400">{sizeLabel(file.size)}</span><button type="button" aria-label={`${file.name}を選択から外す`} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setSelectedFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}><X size={15} /></button></div>)}</div>}<div className="mt-4 flex justify-end gap-2"><button type="button" className="pm-secondary" disabled={busy !== ""} onClick={() => { setSelectedFiles([]); setShowUpload(false); }}>キャンセル</button><button type="button" className="pm-primary min-w-40" disabled={busy !== "" || selectedFiles.length === 0} onClick={() => void uploadAll()}>{busy.startsWith("upload") ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />{busy === "upload" ? "準備中…" : `${busy.split("-")[1]}/${busy.split("-")[2]} アップロード中`}</> : <><UploadCloud size={16} />アップロード</>}</button></div></div>}
      </div>
      {filteredDocuments.length === 0 ? <div className="grid min-h-52 place-items-center p-6 text-center"><div><FolderArchive size={34} className="mx-auto text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">条件に一致する添付書類はありません</p></div></div> : <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">書類名</th><th className="px-4 py-3 text-left">分類</th><th className="px-4 py-3 text-left">説明</th><th className="px-4 py-3 text-left">登録者・日時</th><th className="px-4 py-3 text-right">サイズ</th><th className="px-4 py-3 text-center">状態</th><th className="px-4 py-3 text-center">操作</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredDocuments.map((document) => <tr key={document.id} className={document.status === "archived" ? "bg-slate-50 text-slate-400" : "hover:bg-slate-50/60"}><td className="px-4 py-4"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${document.status === "archived" ? "bg-slate-100 text-slate-400" : "bg-blue-50 text-blue-700"}`}>{fileIcon(document.contentType, document.name)}</span><div className="min-w-0"><p className="max-w-80 truncate font-bold">{document.name}</p><p className="mt-1 text-[10px] text-slate-400">{document.contentType || "ファイル"}</p></div></div></td><td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${CATEGORY_STYLES[document.category]}`}>{CATEGORY_LABELS[document.category]}</span></td><td className="max-w-80 whitespace-pre-wrap px-4 py-4 text-slate-500">{document.description || "—"}</td><td className="px-4 py-4"><p className="font-semibold">{document.uploadedByName || "—"}</p><p className="mt-1 text-xs text-slate-400">{dateLabel(document.createdAt)}</p></td><td className="px-4 py-4 text-right tabular-nums">{sizeLabel(document.size)}</td><td className="px-4 py-4 text-center"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${document.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{document.status === "active" ? "保管中" : "アーカイブ"}</span></td><td className="px-4 py-4"><div className="flex justify-center gap-2">{document.fileUrl && <a className="pm-secondary" href={document.fileUrl} target="_blank" rel="noopener noreferrer"><Download size={14} />開く</a>}{canEdit && <button type="button" aria-label={document.status === "active" ? "アーカイブ" : "復元"} title={document.status === "active" ? "アーカイブ" : "復元"} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" disabled={busy !== ""} onClick={() => void changeStatus(document)}>{document.status === "active" ? <Archive size={15} /> : <ArchiveRestore size={15} />}</button>}</div></td></tr>)}</tbody></table></div>}
    </section>
    {message && <p role="status" className={`rounded-xl p-4 text-sm ${message.includes("できません") || message.includes("超過") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}
  </div>;
}
