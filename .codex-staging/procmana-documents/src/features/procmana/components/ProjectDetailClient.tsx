"use client";
/* eslint-disable react-hooks/incompatible-library -- React Hook Form watch is intentionally used for live monetary totals. */

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, BookUser, CheckCircle2, ChevronRight, CircleOff, FileDown, Link2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { convertPrice, estimateTotals, formatPercent, formatYen, lineTotals, projectKpis } from "../calculations";
import { canConfirmContract, canEditEstimates, canEditProjectInfo, canManageBudget, canManageDocuments, canManageOrders, canManagePayments, canViewFinancials, canViewProject } from "../permissions";
import { contractSchema, estimateHeaderSchema, projectSchema, type ContractFormInput, type ContractInput, type EstimateHeaderFormInput, type EstimateHeaderInput, type ProjectFormInput, type ProjectInput } from "../schemas";
import { cancelContract, confirmContract, getProject, listCustomers, listEstimates, saveCustomer, saveEstimate, updateProjectBasicInfo } from "../services/repository";
import type { ConversionMode, Customer, Estimate, EstimateLine, Project } from "../types";
import { PageHeader } from "./PageHeader";
import { EstimateEditor as ProcNovaEstimateEditor } from "./EstimateEditor";
import { useProcManaSession } from "./ProcManaProvider";
import { statusLabels } from "./ProjectsClient";
import { BudgetPanel } from "./BudgetPanel";
import { CostPanel } from "./CostPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { InvoicePanel } from "./InvoicePanel";
import { OrderPanel } from "./OrderPanel";
import { PaymentPanel } from "./PaymentPanel";
import { ProgressPanel } from "./ProgressPanel";

const tabs = [
  ["overview", "概要"], ["estimate", "見積"], ["contract", "契約"], ["budget", "実行予算"],
  ["orders", "発注"], ["costs", "原価"], ["progress", "出来高"], ["invoices", "請求"],
  ["payments", "入金"], ["documents", "書類"], ["procnova", "ProcNova連携"], ["history", "操作履歴"],
] as const;

type ProjectTab = (typeof tabs)[number][0];

function normalizeProjectTab(value: string | null): ProjectTab {
  return tabs.some(([tab]) => tab === value) ? value as ProjectTab : "overview";
}

function freshLine(parentId: string | null = null): EstimateLine {
  return { id: `line-${crypto.randomUUID()}`, parentId, lineType: "detail", sortOrder: Date.now(), workType: "", itemName: "", specification: "", specNumber: "", quantity: parentId ? 1 : 0, unit: parentId ? "式" : "", unitPrice: 0, amount: 0, costUnitPrice: 0, costAmount: 0, profit: 0, profitRate: 0, notes: "" };
}

function FieldError({ message }: { message?: string }) { return message ? <span className="mt-1 block text-xs text-red-600">{message}</span> : null; }

function Overview({ project, financials, demo, onSaved }: { project: Project; financials: boolean; demo: boolean; onSaved: () => Promise<void> }) {
  const { member } = useProcManaSession();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [customerBusy, setCustomerBusy] = useState(false);
  const { register, handleSubmit, reset, setValue, getValues, formState: { errors, isSubmitting } } = useForm<ProjectFormInput, unknown, ProjectInput>({ resolver: zodResolver(projectSchema), values: { name: project.name, customerName: project.customerName, customerContact: project.customerContact, customerAddress: project.customerAddress, siteAddress: project.siteAddress, phone: project.phone, email: project.email, managerId: project.managerId, managerName: project.managerName, estimateDueDate: project.estimateDueDate, plannedStartDate: project.plannedStartDate, plannedEndDate: project.plannedEndDate, winProbability: project.winProbability, notes: project.notes } });
  const kpi = projectKpis(project);
  const cards = [
    ["契約金額", project.contractAmount, "yen"], ["予定原価", project.plannedCost, "yen"], ["実績原価", project.actualCost, "yen"],
    ["予定粗利", kpi.plannedProfit, "yen"], ["現在粗利", kpi.currentProfit, "yen"], ["利益率", kpi.currentProfitRate, "percent"],
    ["施工進捗率", project.constructionProgress, "percent"], ["請求出来高率", project.billingProgress, "percent"], ["請求済み金額", project.invoicedAmount, "yen"],
    ["未請求金額", kpi.uninvoicedAmount, "yen"], ["入金済み金額", project.paidAmount, "yen"], ["未入金金額", kpi.unpaidAmount, "yen"],
  ] as const;
  useEffect(() => {
    if (!editing || !member) return;
    let active = true;
    listCustomers(member, demo).then((next) => { if (active) setCustomers(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [demo, editing, member]);

  // 顧客マスタを選ぶと、工事の顧客情報へ反映する
  function applyCustomer(customerId: string) {
    setSelectedCustomerId(customerId);
    const customer = customers.find((item) => item.id === customerId);
    if (!customer) return;
    setValue("customerName", customer.name);
    setValue("customerAddress", customer.postalCode ? `〒${customer.postalCode.slice(0, 3)}-${customer.postalCode.slice(3)} ${customer.address}`.trim() : customer.address);
    setValue("customerContact", customer.contact);
    setMessage(`顧客マスタ「${customer.name}」を反映しました。`);
  }

  // 入力中の顧客情報をマスタへ登録・更新する
  async function storeCustomer() {
    if (!member) return;
    const values = getValues();
    if (!values.customerName?.trim()) { setMessage("顧客名を入力してください。"); return; }
    setCustomerBusy(true); setMessage("");
    try {
      const existing = customers.find((item) => item.id === selectedCustomerId);
      const id = await saveCustomer(member, {
        id: existing?.id ?? "", ownerUid: member.uid, postalCode: existing?.postalCode ?? "",
        name: values.customerName, address: values.customerAddress ?? "", contact: values.customerContact ?? "",
        phone: existing?.phone ?? "", email: existing?.email ?? "", registrationNumber: existing?.registrationNumber ?? "",
        notes: existing?.notes ?? "", createdAt: existing?.createdAt ?? "", updatedAt: "",
      }, demo);
      setSelectedCustomerId(id);
      setCustomers(await listCustomers(member, demo));
      setMessage(existing ? `顧客マスタ「${values.customerName}」を更新しました。` : `顧客マスタへ「${values.customerName}」を登録しました。次回から選択できます。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "顧客マスタに保存できませんでした。");
    } finally { setCustomerBusy(false); }
  }

  const submit = handleSubmit(async (input) => {
    if (!member) return;
    setMessage("");
    try {
      await updateProjectBasicInfo(member, project, input, demo);
      setEditing(false);
      setMessage("工事基本情報を保存しました。");
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "工事基本情報を保存できませんでした。");
    }
  });
  return <div className="space-y-6"><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, kind]) => <div key={label} className="pm-card"><p className="text-xs font-semibold text-slate-500">{label}</p><p className={`mt-3 text-2xl font-bold tabular-nums ${label === "利益率" && value < 15 ? "text-red-600" : ""}`}>{financials || label.includes("率") ? kind === "yen" ? formatYen(value) : formatPercent(value) : "非表示"}</p></div>)}</section><section className="pm-card">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">工事基本情報</h2>{canEditProjectInfo(project) && !editing && <button type="button" className="pm-secondary" onClick={() => { reset(); setMessage(""); setEditing(true); }}><Pencil size={15} />編集</button>}</div>
    {editing ? <form onSubmit={submit} className="mt-5 space-y-5">
      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm font-semibold"><span className="flex items-center gap-1.5"><BookUser size={15} className="text-blue-700" />顧客マスタから選択</span>
          <select className="pm-input mt-2 bg-white" value={selectedCustomerId} onChange={(event) => applyCustomer(event.target.value)}>
            <option value="">選択して顧客情報を反映</option>
            {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.address ? ` — ${customer.address}` : ""}</option>)}
          </select>
        </label>
        <button type="button" className="pm-secondary h-12 shrink-0 whitespace-nowrap" disabled={customerBusy} onClick={() => void storeCustomer()}><Save size={15} />{customerBusy ? "保存中…" : selectedCustomerId ? "マスタを更新" : "この顧客をマスタに登録"}</button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label className="text-sm font-semibold">工事名<input className="pm-input mt-2" {...register("name")} /><FieldError message={errors.name?.message} /></label>
        <label className="text-sm font-semibold">顧客名<input className="pm-input mt-2" {...register("customerName")} /><FieldError message={errors.customerName?.message} /></label>
        <label className="text-sm font-semibold">顧客担当者<input className="pm-input mt-2" {...register("customerContact")} /></label>
        <label className="text-sm font-semibold md:col-span-2 xl:col-span-3">顧客住所<input className="pm-input mt-2" placeholder="請求書の宛先に印字されます" {...register("customerAddress")} /></label>
        <label className="text-sm font-semibold">担当者<input className="pm-input mt-2" {...register("managerName")} /><FieldError message={errors.managerName?.message} /></label>
        <label className="text-sm font-semibold md:col-span-2 xl:col-span-3">現場住所<input className="pm-input mt-2" placeholder="発注書・ProcNova連携で使用します" {...register("siteAddress")} /><FieldError message={errors.siteAddress?.message} /></label>
        <label className="text-sm font-semibold">見積提出予定日<input type="date" className="pm-input mt-2" {...register("estimateDueDate")} /></label>
        <label className="text-sm font-semibold">着工予定日<input type="date" className="pm-input mt-2" {...register("plannedStartDate")} /></label>
        <label className="text-sm font-semibold">完成予定日<input type="date" className="pm-input mt-2" {...register("plannedEndDate")} /><FieldError message={errors.plannedEndDate?.message} /></label>
        <label className="text-sm font-semibold">受注確率<input type="number" min="0" max="100" className="pm-input mt-2" {...register("winProbability")} /><FieldError message={errors.winProbability?.message} /></label>
        <label className="text-sm font-semibold md:col-span-2">備考<textarea rows={3} className="pm-input mt-2 resize-y" {...register("notes")} /></label>
      </div>
      <div className="flex justify-end gap-2"><button type="button" className="pm-secondary" disabled={isSubmitting} onClick={() => { reset(); setEditing(false); }}>キャンセル</button><button disabled={isSubmitting} className="pm-primary min-w-36"><Save size={16} />{isSubmitting ? "保存中…" : "基本情報を保存"}</button></div>
    </form> : <dl className="mt-5 grid gap-x-8 gap-y-5 text-sm md:grid-cols-2 xl:grid-cols-3">{[["顧客名", project.customerName], ["顧客担当者", project.customerContact || "—"], ["顧客住所", project.customerAddress || "—"], ["担当者", project.managerName], ["現場住所", project.siteAddress || "未入力"], ["工期", `${project.plannedStartDate || "未定"} 〜 ${project.plannedEndDate || "未定"}`], ["受注確率", `${project.winProbability}%`], ["備考", project.notes || "—"]].map(([label, value]) => <div key={label}><dt className="text-xs font-semibold text-slate-400">{label}</dt><dd className="mt-1 font-semibold text-slate-700">{value}</dd></div>)}</dl>}
    {message && <p role="status" className={`mt-4 rounded-xl p-4 text-sm ${message.includes("できません") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}
  </section></div>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 新UI移行中の既存見積エディタ。保存済みデータ互換の参照用に残す。
function EstimateEditor({ project, estimates, canEdit, demo, onSaved }: { project: Project; estimates: Estimate[]; canEdit: boolean; demo: boolean; onSaved: () => Promise<void> }) {
  const { member } = useProcManaSession();
  const [selectedId, setSelectedId] = useState(estimates[0]?.id ?? "new");
  const selected = estimates.find((estimate) => estimate.id === selectedId);
  const [lines, setLines] = useState<EstimateLine[]>(selected?.lines ?? [freshLine(null), freshLine(null)]);
  const [mode, setMode] = useState<ConversionMode>("order_rate");
  const [rate, setRate] = useState(80);
  const [workTypeRate, setWorkTypeRate] = useState<Record<string, number>>({});
  const [message, setMessage] = useState("");
  const defaults: EstimateHeaderInput = selected ? { estimateNumber: selected.estimateNumber, estimateDate: selected.estimateDate, validUntil: selected.validUntil, subject: selected.subject, paymentTerms: selected.paymentTerms, notes: selected.notes, discount: selected.discount, taxRate: selected.taxRate } : { estimateNumber: `PM-${new Date().getFullYear()}-${String(estimates.length + 1).padStart(4, "0")}`, estimateDate: new Date().toISOString().slice(0, 10), validUntil: "", subject: `${project.name} 御見積`, paymentTerms: "月末締め翌月末払い", notes: "", discount: 0, taxRate: 10 };
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm<EstimateHeaderFormInput, unknown, EstimateHeaderInput>({ resolver: zodResolver(estimateHeaderSchema), values: defaults });
  useEffect(() => { const target = estimates.find((estimate) => estimate.id === selectedId); setLines(target?.lines ?? [freshLine(null), freshLine(null)]); reset(target ? { estimateNumber: target.estimateNumber, estimateDate: target.estimateDate, validUntil: target.validUntil, subject: target.subject, paymentTerms: target.paymentTerms, notes: target.notes, discount: target.discount, taxRate: target.taxRate } : defaults); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = estimateTotals(lines, Number(watch("discount") || 0), Number(watch("taxRate") || 0));

  function updateLine(index: number, key: keyof EstimateLine, raw: string) {
    setLines((current) => current.map((line, lineIndex) => {
      if (index !== lineIndex) return line;
      const numeric = ["quantity", "unitPrice", "costUnitPrice"].includes(key);
      const next = { ...line, [key]: numeric ? Number(raw) : raw };
      return { ...next, ...lineTotals(next) };
    }));
  }
  function applyConversion() {
    try {
      setLines((current) => current.map((line) => {
        if (line.quantity <= 0) return line;
        const appliedRate = line.conversionRate ?? workTypeRate[line.workType] ?? rate;
        const next = mode === "order_rate" ? { ...line, costUnitPrice: convertPrice(line.unitPrice, appliedRate, mode) } : { ...line, unitPrice: convertPrice(line.costUnitPrice, appliedRate, mode) };
        return { ...next, ...lineTotals(next) };
      }));
      setMessage(mode === "order_rate" ? "掛率を原価単価へ反映しました。" : "販売単価へ変換結果を反映しました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "変換できませんでした。"); }
  }
  const submit = handleSubmit(async (header) => { if (!member) return; if (!lines.some((line) => line.itemName.trim())) { setMessage("明細を1件以上入力してください。"); return; } await saveEstimate(member, project, header, lines, { defaultCostRate: 80, workTypeCostRates: {} }, demo, selected?.id); setMessage("見積を保存しました。"); await onSaved(); });
  return <div className="space-y-5"><div className="pm-card flex flex-col gap-4 md:flex-row md:items-center"><div className="flex-1"><label className="text-xs font-bold text-slate-500">表示する見積</label><select className="pm-input mt-2" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="new">＋ 新しい見積を作成</option>{estimates.map((estimate) => <option value={estimate.id} key={estimate.id}>{estimate.estimateNumber} · {estimate.subject} · {formatYen(estimate.total)}</option>)}</select></div>{selected && <span className="pm-status pm-status-estimate_submitted self-start md:self-center">{selected.status === "adopted" ? "契約採用" : selected.status === "submitted" ? "提出済み" : "下書き"}</span>}</div>
    <form onSubmit={submit} className="space-y-5"><section className="pm-card"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-bold">見積ヘッダー</h2><button type="button" onClick={() => window.print()} className="pm-secondary"><FileDown size={16} />PDF保存 / 印刷</button></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><label className="text-sm font-semibold">見積番号<input className="pm-input mt-2" {...register("estimateNumber")} /><FieldError message={errors.estimateNumber?.message} /></label><label className="text-sm font-semibold">見積日<input type="date" className="pm-input mt-2" {...register("estimateDate")} /><FieldError message={errors.estimateDate?.message} /></label><label className="text-sm font-semibold">有効期限<input type="date" className="pm-input mt-2" {...register("validUntil")} /><FieldError message={errors.validUntil?.message} /></label><label className="text-sm font-semibold">消費税率<input type="number" className="pm-input mt-2" {...register("taxRate")} /></label><label className="text-sm font-semibold md:col-span-2">件名<input className="pm-input mt-2" {...register("subject")} /><FieldError message={errors.subject?.message} /></label><label className="text-sm font-semibold">支払条件<input className="pm-input mt-2" {...register("paymentTerms")} /></label><label className="text-sm font-semibold">値引き<input type="number" min="0" className="pm-input mt-2" {...register("discount")} /></label></div></section>
      <section className="pm-card overflow-hidden p-0"><div className="flex flex-col justify-between gap-3 border-b border-slate-200 p-5 md:flex-row md:items-center"><div><h2 className="text-lg font-bold">見積明細</h2><p className="mt-1 text-xs text-slate-500">親明細と子明細で工種ごとの階層を作れます。</p></div>{canEdit && <div className="flex gap-2"><button type="button" className="pm-secondary" onClick={() => setLines((current) => [...current, freshLine(null)])}><Plus size={15} />工種を追加</button><button type="button" className="pm-secondary" onClick={() => setLines((current) => [...current, freshLine(current.findLast((line) => line.parentId === null)?.id ?? null)])}><Plus size={15} />明細を追加</button></div>}</div><div className="overflow-x-auto"><table className="w-full min-w-[1380px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-3 text-left">工種 / 項目名</th><th className="px-3 py-3 text-left">仕様</th><th className="px-3 py-3 text-right">数量</th><th className="px-3 py-3">単位</th><th className="px-3 py-3 text-right">単価</th><th className="px-3 py-3 text-right">金額</th><th className="px-3 py-3 text-right">原価単価</th><th className="px-3 py-3 text-right">原価金額</th><th className="px-3 py-3 text-right">利益</th><th className="px-3 py-3 text-right">利益率</th><th className="px-3 py-3 text-right">個別率</th><th></th></tr></thead><tbody className="divide-y divide-slate-100">{lines.map((line, index) => <tr key={line.id} className={line.parentId ? "" : "bg-blue-50/35 font-semibold"}><td className="px-3 py-2"><div className={`grid gap-1 ${line.parentId ? "ml-5 grid-cols-[100px_1fr]" : "grid-cols-1"}`}><input disabled={!canEdit} className="pm-table-input" value={line.workType} onChange={(e) => updateLine(index, "workType", e.target.value)} placeholder="工種" /><input disabled={!canEdit} className="pm-table-input" value={line.itemName} onChange={(e) => updateLine(index, "itemName", e.target.value)} placeholder={line.parentId ? "項目名" : "工種見出し"} /></div></td><td className="px-3 py-2"><input disabled={!canEdit} className="pm-table-input" value={line.specification} onChange={(e) => updateLine(index, "specification", e.target.value)} /></td><td className="px-3 py-2"><input disabled={!canEdit} type="number" step="0.01" className="pm-table-input text-right" value={line.quantity} onChange={(e) => updateLine(index, "quantity", e.target.value)} /></td><td className="px-3 py-2"><input disabled={!canEdit} className="pm-table-input text-center" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)} /></td><td className="px-3 py-2"><input disabled={!canEdit} type="number" className="pm-table-input text-right" value={line.unitPrice} onChange={(e) => updateLine(index, "unitPrice", e.target.value)} /></td><td className="px-3 py-2 text-right font-semibold tabular-nums">{formatYen(line.amount)}</td><td className="px-3 py-2"><input disabled={!canEdit} type="number" className="pm-table-input text-right" value={line.costUnitPrice} onChange={(e) => updateLine(index, "costUnitPrice", e.target.value)} /></td><td className="px-3 py-2 text-right tabular-nums">{formatYen(line.costAmount)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{formatYen(line.profit)}</td><td className={`px-3 py-2 text-right font-bold tabular-nums ${line.profitRate < 15 && line.amount > 0 ? "text-red-600" : "text-emerald-700"}`}>{formatPercent(line.profitRate)}</td><td className="px-3 py-2"><input disabled={!canEdit} type="number" className="pm-table-input w-20 text-right" value={line.conversionRate ?? ""} placeholder="継承" onChange={(e) => setLines((current) => current.map((item, i) => i === index ? { ...item, conversionRate: e.target.value ? Number(e.target.value) : undefined } : item))} /></td><td className="px-2 py-2">{canEdit && <button type="button" className="rounded-lg p-2 text-slate-300 hover:bg-red-50 hover:text-red-600" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id && item.parentId !== line.id))}><Trash2 size={15} /></button>}</td></tr>)}</tbody></table></div><div className="grid justify-end gap-2 border-t border-slate-200 bg-slate-50 p-5 text-sm sm:grid-cols-[180px_180px]"><span className="text-slate-500">小計</span><b className="text-right tabular-nums">{formatYen(totals.subtotal)}</b><span className="text-slate-500">消費税</span><b className="text-right tabular-nums">{formatYen(totals.tax)}</b><span className="pt-2 text-base font-bold">合計金額</span><b className="pt-2 text-right text-xl tabular-nums text-blue-800">{formatYen(totals.total)}</b></div></section>
      <section className="pm-card"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><h2 className="text-lg font-bold">掛率・利益率変換</h2><p className="mt-1 text-xs text-slate-500">全体率を工種別、明細別の設定で上書きできます。</p></div><div className="grid gap-3 sm:grid-cols-[200px_120px_auto]"><select className="pm-input" value={mode} onChange={(e) => setMode(e.target.value as ConversionMode)}><option value="order_rate">発注掛率（販売→原価）</option><option value="markup">原価へ上乗せ</option><option value="target_margin">目標利益率から逆算</option></select><label className="relative"><input type="number" className="pm-input pr-9! text-right" value={rate} onChange={(e) => setRate(Number(e.target.value))} /><span className="absolute right-3 top-3 text-sm text-slate-400">%</span></label><button type="button" className="pm-primary" onClick={applyConversion}>全明細へ適用</button></div></div><div className="mt-4 flex flex-wrap gap-2">{[...new Set(lines.map((line) => line.workType).filter(Boolean))].map((workType) => <label key={workType} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold">{workType}<input type="number" className="w-16 rounded border border-slate-200 bg-white px-2 py-1 text-right" value={workTypeRate[workType] ?? ""} placeholder={`${rate}`} onChange={(e) => setWorkTypeRate((current) => ({ ...current, [workType]: Number(e.target.value) }))} />%</label>)}</div></section>
      <label className="pm-card block text-sm font-semibold">備考<textarea rows={3} className="pm-input mt-2" {...register("notes")} /></label>{message && <p role="status" className="rounded-xl bg-blue-50 p-4 text-sm text-blue-800">{message}</p>}<div className="flex justify-end"><button disabled={!canEdit || isSubmitting} className="pm-primary min-w-36"><Save size={16} />{isSubmitting ? "保存中..." : "見積を保存"}</button></div>
    </form></div>;
}

function ContractPanel({ project, estimates, demo, onConfirmed }: { project: Project; estimates: Estimate[]; demo: boolean; onConfirmed: () => Promise<void> }) {
  const { member } = useProcManaSession();
  const [message, setMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const adopted = estimates.find((estimate) => estimate.status === "adopted");
  const contractActive = project.contractState === "active";
  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<ContractFormInput, unknown, ContractInput>({ resolver: zodResolver(contractSchema), defaultValues: { estimateId: adopted?.id ?? estimates[0]?.id ?? "", amount: adopted?.total ?? estimates[0]?.total ?? 0, contractDate: new Date().toISOString().slice(0, 10), startDate: project.plannedStartDate, plannedEndDate: project.plannedEndDate, paymentTerms: adopted?.paymentTerms ?? "", notes: "" } });
  const selectedId = watch("estimateId");
  const [taxExclusiveAmount, setTaxExclusiveAmount] = useState(() => {
    const base = adopted ?? estimates[0];
    return base ? Math.max(0, base.subtotal - (base.discount ?? 0)) : 0;
  });
  const selectedEstimate = estimates.find((item) => item.id === selectedId);
  const contractTaxRate = selectedEstimate?.taxRate ?? 10;
  const contractTaxAmount = Math.round(taxExclusiveAmount * contractTaxRate / 100);
  const contractTaxIncluded = taxExclusiveAmount + contractTaxAmount;

  // 税抜金額を正とし、税込契約金額（保存値）を即時再計算する
  function syncContractAmount(base: number) {
    const safe = Math.max(0, Math.round(Number.isFinite(base) ? base : 0));
    setTaxExclusiveAmount(safe);
    setValue("amount", safe + Math.round(safe * contractTaxRate / 100));
  }

  useEffect(() => {
    const estimate = estimates.find((item) => item.id === selectedId);
    if (estimate) {
      setValue("amount", estimate.total);
      setValue("paymentTerms", estimate.paymentTerms);
      setTaxExclusiveAmount(Math.max(0, estimate.subtotal - (estimate.discount ?? 0)));
    }
  }, [estimates, selectedId, setValue]);
  const submit = handleSubmit(async (input) => { if (!member) return; const estimate = estimates.find((item) => item.id === input.estimateId); if (!estimate) { setMessage("採用する見積を選択してください。"); return; } if (!window.confirm("契約を確定します。見積採用、初期予算作成、ProcNova連携を実行してよろしいですか？")) return; try { await confirmContract(member, project, estimate, input, demo); setMessage("契約を確定し、ProcNovaプロジェクトを作成しました。"); await onConfirmed(); } catch (error) { setMessage(error instanceof Error ? error.message : "契約確定に失敗しました。再度お試しください。"); } });

  async function cancel() {
    if (!member || !contractActive) return;
    if (!window.confirm("契約を解除します。契約記録・実行予算・ProcNova連携・共有コードは削除されず、解除履歴を保存します。よろしいですか？")) return;
    setCancelling(true);
    setMessage("");
    try {
      await cancelContract(member, project, demo);
      setMessage("契約を解除しました。既存データは保持されています。");
      await onConfirmed();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "契約解除に失敗しました。再度お試しください。");
    } finally {
      setCancelling(false);
    }
  }

  const actionItems = contractActive
    ? ["工事ステータスに契約解除を記録", "契約記録に解除日時・解除者を追記", "実行予算をそのまま保持", "ProcNova連携と共有コードを保持", "契約金額・原価データを保持", "操作履歴を保存"]
    : project.contractState === "cancelled"
      ? ["工事ステータスを契約済みに戻す", "元の契約記録を有効に戻す", "調整済みの実行予算を保持", "既存のProcNovaプロジェクトを再利用", "現場共有コードを保持", "再開の操作履歴を保存"]
      : ["工事ステータスを契約済みに変更", "採用見積を確定版として保存", "見積原価から実行予算を作成", "ProcNovaプロジェクトを作成・再利用", "現場共有コードを発行・保持", "操作履歴を保存"];

  return <div className="grid gap-6 xl:grid-cols-[1.2fr_.8fr]">
    <form onSubmit={submit} className="pm-card space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-bold">{contractActive ? "契約中" : project.contractState === "cancelled" ? "契約再確定" : "契約確定"}</h2>{contractActive && <span className="pm-status pm-status-contracted">契約済み</span>}{project.contractState === "cancelled" && <span className="pm-status pm-status-contract_cancelled">解除履歴あり</span>}</div>
        <p className="mt-1 text-sm text-slate-500">{contractActive ? "解除しても契約・実行予算・ProcNovaのデータは削除されません。" : "採用見積を確定し、実行予算とProcNovaプロジェクトを作成します。"}</p>
        {project.contractCancelledAt && <p className="mt-2 text-xs text-rose-600">最終解除日時：{new Date(project.contractCancelledAt).toLocaleString("ja-JP")}</p>}
      </div>
      {estimates.length === 0 ? <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">先に見積を作成してください。</div> : <>
        <fieldset disabled={contractActive || isSubmitting || cancelling} className="space-y-5 disabled:opacity-60">
          <label className="block text-sm font-semibold">採用する見積<select className="pm-input mt-2" {...register("estimateId")}><option value="">選択してください</option>{estimates.map((estimate) => <option key={estimate.id} value={estimate.id}>{estimate.estimateNumber} · {formatYen(estimate.total)}</option>)}</select><FieldError message={errors.estimateId?.message} /></label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="text-sm font-semibold sm:col-span-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">契約金額（税抜）<input type="number" className="pm-input mt-2" value={taxExclusiveAmount === 0 ? "" : taxExclusiveAmount} placeholder="0" onChange={(event) => syncContractAmount(Number(event.target.value || 0))} /><FieldError message={errors.amount?.message} /></label>
                <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                  <div className="flex items-baseline justify-between text-xs font-semibold text-slate-500"><span>消費税（{contractTaxRate}%）</span><span className="tabular-nums">{formatYen(contractTaxAmount)}</span></div>
                  <div className="mt-1.5 flex items-baseline justify-between"><span className="text-xs font-semibold text-slate-500">契約金額（税込）</span><b className="text-2xl tabular-nums text-blue-800">{formatYen(contractTaxIncluded)}</b></div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <button type="button" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-400 transition hover:border-slate-300 hover:text-slate-600" onClick={() => { const selected = estimates.find((item) => item.id === selectedId); if (selected) syncContractAmount(Math.max(0, selected.subtotal - (selected.discount ?? 0))); }}>見積額に戻す</button>
                <span className="text-[11px] font-normal text-slate-400">端数処理は見積タブ（工種ごと）で行えます。</span>
              </div>
              {(() => {
                const selected = estimates.find((item) => item.id === selectedId);
                if (!selected || selected.total <= 0) return null;
                const difference = contractTaxIncluded - selected.total;
                if (difference === 0) return null;
                return <p className={`mt-2 text-xs font-semibold ${difference < 0 ? "text-emerald-700" : "text-amber-700"}`}>見積合計（税込）{formatYen(selected.total)}との差額：{difference > 0 ? "+" : "−"}{formatYen(Math.abs(difference))}{difference < 0 ? "（端数調整・値引き）" : ""}</p>;
              })()}
            </div>
            <label className="text-sm font-semibold">契約日<input type="date" className="pm-input mt-2" {...register("contractDate")} /></label>
            <label className="text-sm font-semibold">着工日<input type="date" className="pm-input mt-2" {...register("startDate")} /></label>
            <label className="text-sm font-semibold">完成予定日<input type="date" className="pm-input mt-2" {...register("plannedEndDate")} /><FieldError message={errors.plannedEndDate?.message} /></label>
          </div>
          <label className="block text-sm font-semibold">支払条件<textarea rows={2} className="pm-input mt-2" {...register("paymentTerms")} /></label>
          <label className="block text-sm font-semibold">備考<textarea rows={3} className="pm-input mt-2" {...register("notes")} /></label>
        </fieldset>
        {message && <p className={`rounded-xl p-4 text-sm ${message.includes("失敗") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{message}</p>}
        {contractActive
          ? <button type="button" disabled={cancelling || !member || !canConfirmContract(project)} onClick={() => void cancel()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-3 font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"><CircleOff size={17} />{cancelling ? "解除処理中..." : "契約を解除"}</button>
          : <button disabled={isSubmitting || !member || !canConfirmContract(project)} className="pm-primary w-full"><CheckCircle2 size={17} />{isSubmitting ? "確定処理中..." : "契約を確定"}</button>}
      </>}
    </form>
    <aside className="space-y-5">
      <div className="pm-card"><h3 className="font-bold">{contractActive ? "解除時に保持・記録" : "確定時に実行"}</h3><ol className="mt-4 space-y-3 text-sm text-slate-600">{actionItems.map((item, index) => <li key={item} className="flex gap-3"><span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${contractActive ? "bg-rose-50 text-rose-700" : "bg-blue-50 text-blue-700"}`}>{index + 1}</span>{item}</li>)}</ol></div>
      <div className="pm-card border-blue-100 bg-blue-50/60"><div className="flex items-center gap-2 font-bold text-blue-900"><Link2 size={18} />ProcNovaへの送信制限</div><p className="mt-3 text-sm leading-6 text-blue-800">工事名、現場住所、工期、担当者、顧客名のみ送信します。契約金額、原価、粗利、利益率、下請単価は送信しません。契約解除時もProcNova側の工事は削除しません。</p></div>
    </aside>
  </div>;
}

function Placeholder({ label, phase }: { label: string; phase: string }) { return <div className="pm-card grid min-h-80 place-items-center text-center"><div><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><ChevronRight /></div><h2 className="mt-4 text-lg font-bold">{label}</h2><p className="mt-2 text-sm text-slate-500">{phase}で業務機能を実装します。データモデルとタブ導線は準備済みです。</p></div></div>; }

export function ProjectDetailClient({ projectId }: { projectId: string }) {
  const { member, demo } = useProcManaSession(); const search = useSearchParams();
  const [activeTab, setActiveTab] = useState<ProjectTab>(() => normalizeProjectTab(search.get("tab")));
  const [project, setProject] = useState<Project | null>(null); const [estimates, setEstimates] = useState<Estimate[]>([]); const [loading, setLoading] = useState(true);
  const selectTab = (nextTab: ProjectTab) => {
    setActiveTab(nextTab);
    window.history.replaceState(window.history.state, "", `/procmana/projects/${projectId}?tab=${nextTab}`);
  };
  const load = useCallback(async () => { if (!member) return; const [nextProject, nextEstimates] = await Promise.all([getProject(member, projectId, demo), listEstimates(member, projectId, demo)]); setProject(nextProject); setEstimates(nextEstimates); setLoading(false); }, [demo, member, projectId]);
  useEffect(() => {
    if (!member) return;
    Promise.all([getProject(member, projectId, demo), listEstimates(member, projectId, demo)]).then(([nextProject, nextEstimates]) => {
      setProject(nextProject);
      setEstimates(nextEstimates);
      setLoading(false);
    });
  }, [demo, member, projectId]);
  if (loading) return <div className="grid min-h-[60vh] place-items-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-blue-700 border-t-transparent" /></div>;
  if (!project || !member || !canViewProject(member, projectId)) return <div className="pm-card py-20 text-center"><h1 className="text-xl font-bold">工事が見つかりません</h1><Link href="/procmana/projects" className="pm-primary mt-5 inline-flex">一覧へ戻る</Link></div>;
  const financials = canViewFinancials(project);
  return <div className="pm-project-print"><PageHeader eyebrow="Project detail" title={project.name} description={`${project.customerName} · ${project.siteAddress}`} actions={<><Link href="/procmana/projects" className="pm-secondary"><ArrowLeft size={16} />一覧</Link><span className={`pm-status pm-status-${project.status} self-center`}>{statusLabels[project.status]}</span></>} />
    <div className="mb-6 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1"><nav aria-label="工事管理メニュー" className="flex min-w-max">{tabs.map(([value, label]) => <button type="button" key={value} aria-current={activeTab === value ? "page" : undefined} onClick={() => selectTab(value)} className={`rounded-lg px-4 py-2.5 text-sm font-semibold ${activeTab === value ? "bg-[#142c8e] text-white" : "text-slate-500 hover:bg-slate-50"}`}>{label}</button>)}</nav></div>
    {activeTab === "overview" && <Overview project={project} financials={financials} demo={demo} onSaved={load} />}
    {activeTab === "estimate" && financials && <ProcNovaEstimateEditor project={project} estimates={estimates} canEdit={canEditEstimates(project)} demo={demo} onSaved={load} />}
    {activeTab === "contract" && financials && <ContractPanel project={project} estimates={estimates} demo={demo} onConfirmed={load} />}
    {activeTab === "budget" && financials && <BudgetPanel project={project} estimates={estimates} canEdit={canManageBudget(project)} demo={demo} onSaved={load} />}
    {activeTab === "orders" && financials && <OrderPanel project={project} canEdit={canManageOrders(project)} demo={demo} onSaved={load} />}
    {activeTab === "procnova" && <div className="pm-card"><div className="flex items-center gap-3"><span className={`grid h-11 w-11 place-items-center rounded-xl ${project.procNovaLinkStatus === "linked" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"}`}><Link2 /></span><div><h2 className="font-bold">ProcNova連携</h2><p className="text-sm text-slate-500">{project.procNovaLinkStatus === "linked" ? `連携済み · ${project.procNovaProjectId}` : "未連携（契約確定時に作成）"}</p></div></div>{project.procNovaProjectUrl && <Link href={project.procNovaProjectUrl} className="pm-primary mt-5 inline-flex">ProcNovaプロジェクトを開く</Link>}</div>}
    {!financials && ["estimate", "contract", "budget", "orders", "costs", "invoices", "payments"].includes(activeTab) && <div className="pm-card py-20 text-center text-sm text-slate-500">この情報を表示する権限がありません。</div>}
    {financials && activeTab === "costs" && <CostPanel project={project} canEdit={canManageBudget(project)} demo={demo} onSaved={load} />}
    {activeTab === "progress" && financials && <ProgressPanel project={project} estimates={estimates} canEdit={canManageBudget(project)} demo={demo} onSaved={load} />}
    {activeTab === "invoices" && financials && <InvoicePanel project={project} estimates={estimates} canEdit={canManageBudget(project)} demo={demo} onSaved={load} />}
    {activeTab === "payments" && financials && <PaymentPanel project={project} canEdit={canManagePayments(project)} demo={demo} onSaved={load} />}
    {activeTab === "documents" && <DocumentsPanel project={project} estimates={estimates} canEdit={canManageDocuments(project)} demo={demo} />}
    {activeTab === "history" && <Placeholder label={tabs.find(([value]) => value === activeTab)?.[1] ?? "管理"} phase="次の実装" />}
  </div>;
}
