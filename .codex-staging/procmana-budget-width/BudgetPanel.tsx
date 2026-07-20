"use client";

import { GripVertical, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from "react";
import { formatYen } from "../calculations";
import { PROC_NOVA_DETAIL_SHEETS } from "../estimateExcel";
import { buildExecutionBudgetFromEstimate, listExecutionBudget, saveExecutionBudget } from "../services/repository";
import type { Estimate, ExecutionBudgetLine, Project } from "../types";
import { useProcManaSession } from "./ProcManaProvider";

type Props = {
  project: Project;
  estimates: Estimate[];
  canEdit: boolean;
  demo: boolean;
  onSaved: () => Promise<void>;
};

const CONSTRUCTION_UNITS = [
  "式", "一式", "㎡", "m", "㎥", "ヶ所", "箇所", "個", "本", "枚", "台", "基", "組", "セット", "人工", "人", "日", "時間", "kg", "t", "L", "袋", "缶", "箱", "巻",
] as const;

function numeric(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberValue(value: number): string {
  return value === 0 ? "" : String(value);
}

function moneyInputValue(value: number): string {
  return value === 0 ? "" : value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function supplementFromEstimate(lines: ExecutionBudgetLine[], estimates: Estimate[]): ExecutionBudgetLine[] {
  const ordered = [...estimates].sort((a, b) => Number(b.status === "adopted") - Number(a.status === "adopted"));
  const sourceByLine = new Map<string, { estimate: Estimate; line: Estimate["lines"][number] }>();
  ordered.forEach((estimate) => estimate.lines.forEach((line) => {
    if (!sourceByLine.has(line.id)) sourceByLine.set(line.id, { estimate, line });
  }));
  return lines.map((budget) => {
    if (!budget.estimateLineId) return budget;
    const source = sourceByLine.get(budget.estimateLineId);
    if (!source) return budget;
    const legacyBudget = !budget.sourceEstimateId;
    return {
      ...budget,
      sourceEstimateId: budget.sourceEstimateId ?? source.estimate.id,
      unit: budget.unit || source.line.unit,
      specification: budget.specification || source.line.specification,
      specNumber: budget.specNumber || source.line.specNumber,
      estimateQuantity: legacyBudget ? source.line.quantity : budget.estimateQuantity,
      estimateCostUnitPrice: legacyBudget ? source.line.costUnitPrice : budget.estimateCostUnitPrice,
      estimateCost: legacyBudget ? source.line.costAmount : budget.estimateCost,
    };
  });
}

function orderedWorkTypesFor(lines: ExecutionBudgetLine[], preferredOrder: string[]): string[] {
  const existing = [...new Set(lines.filter((line) => line.active).map((line) => line.workType.trim()).filter(Boolean))];
  return [...preferredOrder.filter((workType) => existing.includes(workType)), ...existing.filter((workType) => !preferredOrder.includes(workType))];
}

export function BudgetPanel({ project, estimates, canEdit, demo, onSaved }: Props) {
  const { member } = useProcManaSession();
  const preferredEstimate = estimates.find((estimate) => estimate.status === "adopted") ?? estimates[0];
  const [selectedEstimateId, setSelectedEstimateId] = useState(preferredEstimate?.id ?? "");
  const [newLineWorkType, setNewLineWorkType] = useState("");
  const [lines, setLines] = useState<ExecutionBudgetLine[]>([]);
  const [workTypeVendors, setWorkTypeVendors] = useState<Record<string, string>>(project.budgetWorkTypeVendors ?? {});
  const [workTypeOrder, setWorkTypeOrder] = useState<string[]>(project.budgetWorkTypeOrder ?? []);
  const [activeWorkType, setActiveWorkType] = useState(project.budgetWorkTypeOrder?.[0] ?? "");
  const [draggedWorkType, setDraggedWorkType] = useState("");
  const [dropTarget, setDropTarget] = useState<{ workType: string; edge: "before" | "after" } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"reflect" | "save" | "">("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    listExecutionBudget(project.id, demo)
      .then((next) => { if (active) setLines(supplementFromEstimate(next, estimates)); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "実行予算を読み込めませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demo, estimates, project.id]);

  const selectedEstimate = estimates.find((estimate) => estimate.id === selectedEstimateId) ?? preferredEstimate;
  const activeLines = useMemo(() => lines.filter((line) => line.active), [lines]);
  const workTypes = useMemo(() => orderedWorkTypesFor(activeLines, workTypeOrder), [activeLines, workTypeOrder]);
  const displayedWorkType = workTypes.includes(activeWorkType) ? activeWorkType : workTypes[0] ?? "";
  const visibleLines = useMemo(() => displayedWorkType ? activeLines.filter((line) => line.workType === displayedWorkType) : activeLines, [activeLines, displayedWorkType]);
  const workTypeOptions = useMemo(() => [...new Set([...workTypes, ...PROC_NOVA_DETAIL_SHEETS])], [workTypes]);
  const addLineWorkType = newLineWorkType || displayedWorkType || PROC_NOVA_DETAIL_SHEETS[0];
  const estimateCost = activeLines.reduce((sum, line) => sum + line.estimateCost, 0);
  const budgetCost = activeLines.reduce((sum, line) => sum + Math.round(line.budgetQuantity * line.budgetUnitPrice), 0);
  const difference = budgetCost - estimateCost;
  const activeEstimateCost = visibleLines.reduce((sum, line) => sum + line.estimateCost, 0);
  const activeBudgetCost = visibleLines.reduce((sum, line) => sum + Math.round(line.budgetQuantity * line.budgetUnitPrice), 0);
  const activeDifference = activeBudgetCost - activeEstimateCost;

  function updateLine(id: string, patch: Partial<ExecutionBudgetLine>) {
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...patch };
      const nextBudgetCost = Math.round(next.budgetQuantity * next.budgetUnitPrice);
      return { ...next, budgetCost: nextBudgetCost, variance: nextBudgetCost - next.actualCost };
    }));
  }

  async function reflectEstimate() {
    if (!member || !selectedEstimate) return;
    if (activeLines.length > 0 && !window.confirm("現在の実行予算数量・単価を、選択した見積原価で更新します。予定業者・発注額・実績原価は保持されます。続行しますか？")) return;
    setBusy("reflect"); setMessage("");
    try {
      const reflected = buildExecutionBudgetFromEstimate(project.id, selectedEstimate, lines);
      const reflectedWorkTypes = orderedWorkTypesFor(reflected, workTypes);
      const plannedCost = await saveExecutionBudget(member, project, reflected, workTypeVendors, reflectedWorkTypes, demo);
      const savedLines = await listExecutionBudget(project.id, demo);
      setLines(savedLines);
      setWorkTypeOrder(reflectedWorkTypes);
      setActiveWorkType((current) => reflectedWorkTypes.includes(current) ? current : reflectedWorkTypes[0] ?? "");
      setMessage(`見積原価を実行予算へ反映し、業者別の発注書下書きを更新しました。実行予算合計は${formatYen(plannedCost)}です。`);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "見積原価を反映できませんでした。");
    } finally { setBusy(""); }
  }

  async function save() {
    if (!member) return;
    setBusy("save"); setMessage("");
    try {
      const plannedCost = await saveExecutionBudget(member, project, lines, workTypeVendors, workTypes, demo);
      setLines(await listExecutionBudget(project.id, demo));
      setMessage(`実行予算を保存し、業者別の発注書下書きを更新しました。予定原価は${formatYen(plannedCost)}です。`);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "実行予算を保存できませんでした。");
    } finally { setBusy(""); }
  }

  function addLine() {
    const id = `budget-${crypto.randomUUID()}`;
    setWorkTypeOrder((current) => current.includes(addLineWorkType) ? current : [...current, addLineWorkType]);
    setActiveWorkType(addLineWorkType);
    setLines((current) => [...current, {
      id, projectId: project.id, sourceEstimateId: null, estimateLineId: null,
      workType: addLineWorkType, itemName: "", specification: "", specNumber: "", unit: "",
      estimateQuantity: 0, estimateCostUnitPrice: 0, estimateCost: 0,
      budgetQuantity: 0, budgetUnitPrice: 0, budgetCost: 0, plannedVendor: "",
      orderedAmount: 0, actualCost: 0, variance: 0, notes: "", active: true,
      createdAt: "", updatedAt: new Date().toISOString(),
    }]);
  }

  function reorderWorkTypes(source: string, target: string, edge: "before" | "after") {
    if (!source || source === target) return;
    setWorkTypeOrder((current) => {
      const ordered = orderedWorkTypesFor(activeLines, current).filter((workType) => workType !== source);
      const targetIndex = ordered.indexOf(target);
      if (targetIndex < 0) return current;
      ordered.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
      return ordered;
    });
    setMessage("工種シートの並び順を変更しました。実行予算を保存するとFirestoreへ反映されます。");
  }

  function handleWorkTypeDragOver(event: ReactDragEvent<HTMLDivElement>, target: string) {
    if (!canEdit || !draggedWorkType || draggedWorkType === target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropTarget({ workType: target, edge: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after" });
  }

  function finishWorkTypeDrag() {
    setDraggedWorkType("");
    setDropTarget(null);
  }

  if (loading) return <div className="pm-card grid min-h-80 place-items-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-blue-700 border-t-transparent" /></div>;

  return <div className="space-y-5">
    <section className="pm-card overflow-hidden p-0">
      <div className="border-b border-slate-200 px-5 py-5 sm:px-6">
        <h2 className="text-lg font-bold">実行予算</h2>
        <p className="mt-1 text-sm text-slate-500">見積原価を基準に、工種ごとに予算単価と予定業者を調整します。</p>
      </div>
      <div className="grid gap-4 p-5 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3"><p className="text-sm font-bold text-slate-800">見積原価の同期</p><p className="mt-1 text-xs text-slate-500">反映元の見積を選び、最新の原価を取り込みます。</p></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select aria-label="反映元の見積" className="pm-input min-w-0 flex-1 bg-white" value={selectedEstimate?.id ?? ""} onChange={(event) => setSelectedEstimateId(event.target.value)} disabled={busy !== ""}>
              {estimates.length === 0 && <option value="">見積がありません</option>}
              {estimates.map((estimate) => <option value={estimate.id} key={estimate.id}>{estimate.estimateNumber} · {estimate.status === "adopted" ? "採用済み" : "下書き"} · 原価 {formatYen(estimate.lines.reduce((sum, line) => sum + line.costAmount, 0))}</option>)}
            </select>
            <button type="button" className="pm-secondary h-12 shrink-0 whitespace-nowrap" disabled={!canEdit || !selectedEstimate || busy !== ""} onClick={() => void reflectEstimate()}><RefreshCw size={16} className={busy === "reflect" ? "animate-spin" : ""} />{busy === "reflect" ? "反映中…" : activeLines.length > 0 ? "最新原価を反映" : "見積原価を反映"}</button>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3"><p className="text-sm font-bold text-slate-800">予算行の追加</p><p className="mt-1 text-xs text-slate-500">追加先の工種を選び、空の予算行を作成します。</p></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select aria-label="追加先の工種" className="pm-input min-w-0 flex-1 bg-white" disabled={!canEdit || busy !== ""} value={addLineWorkType} onChange={(event) => { const workType = event.target.value; setNewLineWorkType(workType); if (workTypes.includes(workType)) setActiveWorkType(workType); }}>{workTypeOptions.map((workType) => <option key={workType} value={workType}>{workType}</option>)}</select>
            <button type="button" className="pm-secondary h-12 shrink-0 whitespace-nowrap" disabled={!canEdit || busy !== ""} onClick={addLine}><Plus size={16} />予算行を追加</button>
          </div>
        </div>
      </div>
      {workTypes.length > 0 && <nav aria-label="実行予算の工種シート" className="mx-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5"><p className="text-xs font-bold text-slate-500">工種シート</p>{canEdit && <p className="text-[11px] text-slate-400">ドラッグ＆ドロップで並び替え</p>}</div>
        <div role="tablist" aria-label="表示する実行予算工種" className="flex gap-2 overflow-x-auto px-3 pt-3">
          {workTypes.map((workType) => {
            const active = workType === displayedWorkType;
            const dropBefore = dropTarget?.workType === workType && dropTarget.edge === "before";
            const dropAfter = dropTarget?.workType === workType && dropTarget.edge === "after";
            return <div
              key={workType}
              draggable={canEdit}
              className={`relative shrink-0 ${canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${draggedWorkType === workType ? "opacity-40" : ""}`}
              onDragStart={(event) => { setDraggedWorkType(workType); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", workType); }}
              onDragOver={(event) => handleWorkTypeDragOver(event, workType)}
              onDrop={(event) => { event.preventDefault(); const source = draggedWorkType || event.dataTransfer.getData("text/plain"); const edge = dropTarget?.workType === workType ? dropTarget.edge : "before"; reorderWorkTypes(source, workType, edge); finishWorkTypeDrag(); }}
              onDragEnd={finishWorkTypeDrag}
            >
              {dropBefore && <span className="absolute -left-1 top-1 bottom-1 z-20 w-1 rounded-full bg-blue-600" />}
              <button type="button" role="tab" aria-selected={active} className={`flex items-center gap-2 rounded-t-xl border border-b-0 px-4 py-3 text-sm font-bold transition ${active ? "border-blue-700 bg-blue-700 text-white shadow-sm" : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-800"}`} onClick={() => { setActiveWorkType(workType); setNewLineWorkType(workType); }}>
                {canEdit && <GripVertical aria-hidden="true" size={15} className="shrink-0 opacity-60" />}{workType}
              </button>
              {dropAfter && <span className="absolute -right-1 top-1 bottom-1 z-20 w-1 rounded-full bg-blue-600" />}
            </div>;
          })}
        </div>
      </nav>}
      <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">{displayedWorkType || "選択工種"}・見積原価</p><p className="mt-2 text-xl font-bold tabular-nums">{formatYen(activeEstimateCost)}</p></div>
        <div className="rounded-xl bg-blue-50 p-4"><p className="text-xs font-semibold text-blue-700">{displayedWorkType || "選択工種"}・実行予算</p><p className="mt-2 text-xl font-bold tabular-nums text-blue-900">{formatYen(activeBudgetCost)}</p></div>
        <div className={`rounded-xl p-4 ${activeDifference <= 0 ? "bg-emerald-50" : "bg-amber-50"}`}><p className="text-xs font-semibold text-slate-500">選択工種の差額</p><p className={`mt-2 text-xl font-bold tabular-nums ${activeDifference <= 0 ? "text-emerald-700" : "text-amber-800"}`}>{activeDifference > 0 ? "+" : ""}{formatYen(activeDifference)}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold text-slate-500">全工種・実行予算</p><p className="mt-2 text-xl font-bold tabular-nums text-slate-900">{formatYen(budgetCost)}</p><p className={`mt-1 text-xs font-semibold ${difference <= 0 ? "text-emerald-700" : "text-amber-700"}`}>見積比 {difference > 0 ? "+" : ""}{formatYen(difference)}</p></div>
      </div>
      <div className="mx-5 mb-5 flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div><h3 className="text-sm font-bold">{displayedWorkType ? `${displayedWorkType}の予定業者` : "工種別予定業者"}</h3><p className="mt-1 text-xs text-slate-500">明細で個別指定しない場合、この業者を継承します。</p></div>
        {displayedWorkType ? <input aria-label={`${displayedWorkType}の予定業者`} className="pm-input bg-white lg:max-w-xl" disabled={!canEdit} value={workTypeVendors[displayedWorkType] ?? ""} placeholder="業者未定" onChange={(event) => setWorkTypeVendors((current) => ({ ...current, [displayedWorkType]: event.target.value }))} /> : <p className="text-sm text-slate-400">工種を含む予算行を追加すると設定できます。</p>}
      </div>
    </section>

    {activeLines.length > 0 ? <section className="pm-card overflow-hidden p-0">
      <datalist id="budget-construction-units">{CONSTRUCTION_UNITS.map((unit) => <option key={unit} value={unit} />)}</datalist>
      <div className="flex flex-col gap-2 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h3 className="font-bold">{displayedWorkType || "工種未設定"}の予算明細</h3><p className="mt-1 text-xs text-slate-500">見積値を確認しながら、青色の列で実行予算を調整します。</p></div>
        <span className="text-xs font-semibold text-slate-400">{visibleLines.length}行 · 横スクロール対応</span>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[2400px] table-fixed text-sm">
        <colgroup>
          <col style={{ width: 340 }} />
          <col style={{ width: 340 }} />
          <col style={{ width: 144 }} />
          <col style={{ width: 104 }} />
          <col style={{ width: 88 }} />
          <col style={{ width: 136 }} />
          <col style={{ width: 152 }} />
          <col style={{ width: 104 }} />
          <col style={{ width: 136 }} />
          <col style={{ width: 152 }} />
          <col style={{ width: 128 }} />
          <col style={{ width: 260 }} />
          <col style={{ width: 240 }} />
          <col style={{ width: 80 }} />
        </colgroup>
        <thead className="border-b border-slate-200 text-xs text-slate-500">
          <tr className="bg-slate-100 text-[11px] font-bold uppercase tracking-wide"><th colSpan={3} className="border-r border-slate-200 px-3 py-2 text-left">明細情報</th><th colSpan={4} className="border-r border-slate-200 px-3 py-2 text-center">見積原価</th><th colSpan={4} className="border-r border-blue-200 bg-blue-50 px-3 py-2 text-center text-blue-800">実行予算</th><th colSpan={2} className="px-3 py-2 text-center">手配情報</th><th className="sticky right-0 z-20 border-l border-slate-200 bg-slate-100 px-2 py-2 text-center">操作</th></tr>
          <tr className="bg-slate-50"><th className="sticky left-0 z-20 border-r border-slate-200 bg-slate-50 px-3 py-3 text-left shadow-[4px_0_8px_-8px_rgba(15,23,42,0.6)]">品名</th><th className="px-3 py-3 text-left">摘要・仕様</th><th className="px-3 py-3 text-left">仕様番号</th><th className="bg-slate-100/70 px-3 py-3 text-right">数量</th><th className="bg-slate-100/70 px-3 py-3">単位</th><th className="bg-slate-100/70 px-3 py-3 text-right">原価単価</th><th className="border-r border-slate-200 bg-slate-100/70 px-3 py-3 text-right">原価金額</th><th className="bg-blue-50/70 px-3 py-3 text-right text-blue-800">予算数量</th><th className="bg-blue-50/70 px-3 py-3 text-right text-blue-800">予算単価</th><th className="bg-blue-50/70 px-3 py-3 text-right text-blue-800">予算金額</th><th className="border-r border-blue-200 bg-blue-50/70 px-3 py-3 text-right text-blue-800">増減</th><th className="px-3 py-3 text-left">予定業者</th><th className="px-3 py-3 text-left">備考</th><th className="sticky right-0 z-20 border-l border-slate-200 bg-slate-50 px-2 py-3 text-center">操作</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{visibleLines.map((line) => {
          const rowCost = Math.round(line.budgetQuantity * line.budgetUnitPrice);
          const rowDifference = rowCost - line.estimateCost;
          const inheritedVendor = workTypeVendors[line.workType]?.trim() ?? "";
          return <tr key={line.id} className="bg-white align-top transition hover:bg-slate-50/60">
            <td className="sticky left-0 z-10 border-r border-slate-100 bg-white px-3 py-2 shadow-[4px_0_8px_-8px_rgba(15,23,42,0.6)]"><textarea rows={2} className="pm-table-input min-h-14 resize-y whitespace-pre-wrap font-semibold leading-5" disabled={!canEdit} value={line.itemName} placeholder="品名（2行入力対応）" onChange={(event) => updateLine(line.id, { itemName: event.target.value })} /></td>
            <td className="px-3 py-2"><textarea rows={2} className="pm-table-input min-h-16 resize-y whitespace-pre-wrap leading-5" disabled={!canEdit} value={line.specification} placeholder="摘要・仕様・寸法（2行入力対応）" onChange={(event) => updateLine(line.id, { specification: event.target.value })} /></td>
            <td className="px-3 py-2"><input className="pm-table-input" disabled={!canEdit} value={line.specNumber} placeholder="例 AU-2" onChange={(event) => updateLine(line.id, { specNumber: event.target.value })} /></td>
            <td className="bg-slate-50/60 px-3 py-3 text-right tabular-nums">{line.estimateQuantity || "—"}</td>
            <td className="bg-slate-50/60 px-3 py-2"><input list="budget-construction-units" className="pm-table-input bg-white text-center" disabled={!canEdit} value={line.unit} placeholder="選択/入力" onChange={(event) => updateLine(line.id, { unit: event.target.value })} /></td>
            <td className="bg-slate-50/60 px-3 py-3 text-right tabular-nums">{line.estimateCostUnitPrice ? formatYen(line.estimateCostUnitPrice) : "—"}</td><td className="border-r border-slate-200 bg-slate-50/60 px-3 py-3 text-right font-semibold tabular-nums">{line.estimateCost ? formatYen(line.estimateCost) : "—"}</td>
            <td className="bg-blue-50/30 px-3 py-2"><input inputMode="decimal" className="pm-table-input border-blue-100 bg-white text-right" disabled={!canEdit} value={numberValue(line.budgetQuantity)} placeholder="0" onChange={(event) => updateLine(line.id, { budgetQuantity: numeric(event.target.value) })} /></td>
            <td className="bg-blue-50/30 px-3 py-2"><input inputMode="numeric" className="pm-table-input border-blue-100 bg-white text-right tabular-nums" disabled={!canEdit} value={moneyInputValue(line.budgetUnitPrice)} placeholder="0" onChange={(event) => updateLine(line.id, { budgetUnitPrice: numeric(event.target.value) })} /></td>
            <td className="bg-blue-50/30 px-3 py-3 text-right font-bold tabular-nums text-blue-900">{formatYen(rowCost)}</td><td className={`border-r border-blue-100 bg-blue-50/30 px-3 py-3 text-right font-semibold tabular-nums ${rowDifference <= 0 ? "text-emerald-700" : "text-amber-700"}`}>{rowDifference > 0 ? "+" : ""}{formatYen(rowDifference)}</td>
            <td className="px-3 py-2"><div className="grid gap-1"><input className="pm-table-input" disabled={!canEdit} value={line.plannedVendor} placeholder={inheritedVendor ? `継承：${inheritedVendor}` : "個別指定なし"} onChange={(event) => updateLine(line.id, { plannedVendor: event.target.value })} /><span className="text-[10px] text-slate-500">{line.plannedVendor.trim() ? `個別指定：${line.plannedVendor.trim()}` : inheritedVendor ? `継承中：${inheritedVendor}` : "業者未定"}</span></div></td>
            <td className="px-3 py-2"><textarea rows={2} className="pm-table-input min-h-16 resize-y whitespace-pre-wrap leading-5" disabled={!canEdit} value={line.notes} onChange={(event) => updateLine(line.id, { notes: event.target.value })} /></td>
            <td className="sticky right-0 border-l border-slate-100 bg-white px-2 py-2 text-center">{canEdit && <button type="button" aria-label={`${line.itemName || "予算行"}を削除`} title="予算行を削除" className="inline-grid h-9 w-9 place-items-center rounded-lg text-red-600 hover:bg-red-50" onClick={() => updateLine(line.id, { active: false })}><Trash2 size={16} /></button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <div className="grid gap-4 border-t border-slate-200 bg-slate-50 p-5 text-sm lg:grid-cols-2">
        <div className="rounded-xl border border-blue-100 bg-white p-4"><p className="mb-3 text-xs font-bold text-blue-700">選択工種：{displayedWorkType || "工種未設定"}</p><div className="grid grid-cols-[1fr_auto] gap-2"><span className="text-slate-500">見積原価</span><b className="text-right tabular-nums">{formatYen(activeEstimateCost)}</b><span className="text-base font-bold">実行予算</span><b className="text-right text-xl tabular-nums text-blue-800">{formatYen(activeBudgetCost)}</b></div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 lg:ml-auto lg:min-w-[420px]"><p className="mb-3 text-xs font-bold text-slate-500">全工種</p><div className="grid grid-cols-[1fr_auto] gap-2"><span className="text-slate-500">見積原価合計</span><b className="text-right tabular-nums">{formatYen(estimateCost)}</b><span className="text-base font-bold">実行予算合計</span><b className="text-right text-xl tabular-nums text-blue-800">{formatYen(budgetCost)}</b></div></div>
      </div>
    </section> : <div className="pm-card grid min-h-64 place-items-center text-center"><div><h3 className="font-bold">実行予算はまだ作成されていません</h3><p className="mt-2 text-sm text-slate-500">上の「見積原価を反映」から初期予算を作成してください。</p></div></div>}

    {message && <p role="status" className={`rounded-xl p-4 text-sm ${message.includes("できません") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}
    <div className="pointer-events-none sticky bottom-4 z-30 flex justify-end"><button type="button" className="pm-primary pointer-events-auto min-w-44 shadow-xl shadow-slate-900/15" disabled={!canEdit || activeLines.length === 0 || busy !== ""} onClick={() => void save()}><Save size={16} />{busy === "save" ? "保存中…" : "実行予算を保存"}</button></div>
  </div>;
}
