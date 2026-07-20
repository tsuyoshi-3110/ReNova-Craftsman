"use client";

import { Banknote, CalendarClock, CheckCircle2, CircleOff, Landmark, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatYen } from "../calculations";
import { listInvoices, listPayments, savePayment, setPaymentStatus } from "../services/repository";
import type { Invoice, Payment, PaymentMethod, Project } from "../types";
import { useProcManaSession } from "./ProcManaProvider";

type Props = {
  project: Project;
  canEdit: boolean;
  demo: boolean;
  onSaved: () => Promise<void>;
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "銀行振込",
  cash: "現金",
  check: "手形・小切手",
  card: "カード・決済サービス",
  other: "その他",
};

function today(): string { return new Date().toISOString().slice(0, 10); }
function numeric(value: string): number {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function moneyInput(value: number): string { return value > 0 ? Math.round(value).toLocaleString("ja-JP") : ""; }
function dateLabel(value: string): string { return value ? value.replaceAll("-", "/") : "—"; }

export function PaymentPanel({ project, canEdit, demo, onSaved }: Props) {
  const { member } = useProcManaSession();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [payerName, setPayerName] = useState(project.customerName);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const issuedInvoices = useMemo(() => invoices.filter((invoice) => invoice.status === "issued"), [invoices]);
  const activePayments = useMemo(() => payments.filter((payment) => payment.status === "recorded"), [payments]);
  const paidByInvoice = useMemo(() => activePayments.reduce<Record<string, number>>((result, payment) => {
    result[payment.invoiceId] = (result[payment.invoiceId] ?? 0) + payment.amount;
    return result;
  }, {}), [activePayments]);
  const issuedTotal = issuedInvoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const paidTotal = activePayments.reduce((sum, payment) => sum + payment.amount, 0);
  const outstandingTotal = Math.max(0, issuedTotal - paidTotal);
  const paymentRate = issuedTotal > 0 ? Math.min(100, Math.round(paidTotal / issuedTotal * 1000) / 10) : 0;
  const selectedInvoice = issuedInvoices.find((invoice) => invoice.id === invoiceId) ?? null;
  const selectedPaid = selectedInvoice ? paidByInvoice[selectedInvoice.id] ?? 0 : 0;
  const selectedOutstanding = selectedInvoice ? Math.max(0, selectedInvoice.total - selectedPaid) : 0;

  function chooseInvoice(id: string, nextInvoices = issuedInvoices, nextPaidByInvoice = paidByInvoice) {
    setInvoiceId(id);
    const invoice = nextInvoices.find((item) => item.id === id);
    const balance = invoice ? Math.max(0, invoice.total - (nextPaidByInvoice[id] ?? 0)) : 0;
    setAmountText(moneyInput(balance));
  }

  async function reload(preferredInvoiceId = invoiceId) {
    const [nextInvoices, nextPayments] = await Promise.all([listInvoices(project.id, demo), listPayments(project.id, demo)]);
    setInvoices(nextInvoices);
    setPayments(nextPayments);
    const nextIssued = nextInvoices.filter((invoice) => invoice.status === "issued");
    const nextPaid = nextPayments.filter((payment) => payment.status === "recorded").reduce<Record<string, number>>((result, payment) => {
      result[payment.invoiceId] = (result[payment.invoiceId] ?? 0) + payment.amount;
      return result;
    }, {});
    const preferred = nextIssued.find((invoice) => invoice.id === preferredInvoiceId && invoice.total > (nextPaid[invoice.id] ?? 0));
    const next = preferred ?? nextIssued.find((invoice) => invoice.total > (nextPaid[invoice.id] ?? 0)) ?? nextIssued[0];
    chooseInvoice(next?.id ?? "", nextIssued, nextPaid);
  }

  useEffect(() => {
    let active = true;
    Promise.all([listInvoices(project.id, demo), listPayments(project.id, demo)])
      .then(([nextInvoices, nextPayments]) => {
        if (!active) return;
        setInvoices(nextInvoices);
        setPayments(nextPayments);
        const nextIssued = nextInvoices.filter((invoice) => invoice.status === "issued");
        const nextPaid = nextPayments.filter((payment) => payment.status === "recorded").reduce<Record<string, number>>((result, payment) => {
          result[payment.invoiceId] = (result[payment.invoiceId] ?? 0) + payment.amount;
          return result;
        }, {});
        const next = nextIssued.find((invoice) => invoice.total > (nextPaid[invoice.id] ?? 0)) ?? nextIssued[0];
        setInvoiceId(next?.id ?? "");
        setAmountText(moneyInput(next ? Math.max(0, next.total - (nextPaid[next.id] ?? 0)) : 0));
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "入金データを読み込めませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demo, project.id]);

  async function recordPayment() {
    if (!member || !selectedInvoice) return;
    const amount = Math.round(numeric(amountText));
    if (!paymentDate) { setMessage("入金日を入力してください。"); return; }
    if (amount <= 0) { setMessage("入金額を入力してください。"); return; }
    if (amount > selectedOutstanding) { setMessage(`入金額が請求残高を${formatYen(amount - selectedOutstanding)}超えています。`); return; }
    setBusy("record"); setMessage("");
    try {
      await savePayment(member, project, {
        id: "", projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
        invoiceId: selectedInvoice.id, invoiceNumber: selectedInvoice.invoiceNumber,
        paymentDate, amount, method, payerName, referenceNumber, notes,
        status: "recorded", recordedBy: member.uid, recordedByName: member.displayName,
        cancelledAt: null, cancelledBy: null, createdAt: "", updatedAt: "",
      }, demo);
      setReferenceNumber(""); setNotes("");
      await reload(selectedInvoice.id);
      await onSaved();
      setMessage(`${selectedInvoice.invoiceNumber}へ${formatYen(amount)}の入金を登録しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "入金を登録できませんでした。");
    } finally { setBusy(""); }
  }

  async function changeStatus(payment: Payment, status: Payment["status"]) {
    if (!member) return;
    const verb = status === "cancelled" ? "取消" : "復元";
    if (status === "cancelled" && !window.confirm(`${payment.invoiceNumber}の入金 ${formatYen(payment.amount)}を取り消します。記録は削除されません。よろしいですか？`)) return;
    setBusy(payment.id); setMessage("");
    try {
      await setPaymentStatus(member, project, payment.id, status, demo);
      await reload(payment.invoiceId);
      await onSaved();
      setMessage(`入金記録を${verb}しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `入金記録を${verb}できませんでした。`);
    } finally { setBusy(""); }
  }

  if (loading) return <div className="pm-card grid min-h-80 place-items-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-blue-700 border-t-transparent" /></div>;

  return <div className="space-y-6">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="pm-card"><p className="text-xs font-semibold text-slate-500">発行済み請求額</p><p className="mt-3 text-2xl font-bold tabular-nums">{formatYen(issuedTotal)}</p><p className="mt-1 text-xs text-slate-400">発行済み {issuedInvoices.length}件</p></div>
      <div className="pm-card bg-blue-50/70"><p className="text-xs font-semibold text-blue-700">入金済み</p><p className="mt-3 text-2xl font-bold tabular-nums text-blue-900">{formatYen(paidTotal)}</p><p className="mt-1 text-xs text-blue-600">有効な入金 {activePayments.length}件</p></div>
      <div className={`pm-card ${outstandingTotal > 0 ? "bg-amber-50/70" : "bg-emerald-50/70"}`}><p className="text-xs font-semibold text-slate-600">未入金残高</p><p className={`mt-3 text-2xl font-bold tabular-nums ${outstandingTotal > 0 ? "text-amber-800" : "text-emerald-700"}`}>{formatYen(outstandingTotal)}</p><p className="mt-1 text-xs text-slate-500">請求額 − 入金額</p></div>
      <div className="pm-card"><div className="flex items-center justify-between"><p className="text-xs font-semibold text-slate-500">入金率</p><Landmark size={18} className="text-blue-700" /></div><p className="mt-3 text-2xl font-bold tabular-nums">{paymentRate.toLocaleString("ja-JP")}%</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-700 transition-all" style={{ width: `${paymentRate}%` }} /></div></div>
    </section>

    <section className="grid gap-6 xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.6fr)]">
      <div className="pm-card h-fit">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-blue-700"><Banknote size={21} /></span><div><h2 className="font-bold">入金を登録</h2><p className="text-xs text-slate-500">発行済み請求書へ入金を消し込みます。</p></div></div>
        {issuedInvoices.length === 0 ? <div className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">発行済み請求書がありません。先に「請求」タブで請求書を発行してください。</div> : <div className="mt-5 space-y-4">
          <label className="block text-sm font-semibold">対象請求書<select className="pm-input mt-2" disabled={!canEdit || busy !== ""} value={invoiceId} onChange={(event) => chooseInvoice(event.target.value)}>{issuedInvoices.map((invoice) => { const balance = Math.max(0, invoice.total - (paidByInvoice[invoice.id] ?? 0)); return <option key={invoice.id} value={invoice.id}>{invoice.invoiceNumber} · 残 {formatYen(balance)}</option>; })}</select></label>
          {selectedInvoice && <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"><div><p className="text-xs text-slate-400">請求額</p><p className="mt-1 font-bold tabular-nums">{formatYen(selectedInvoice.total)}</p></div><div><p className="text-xs text-slate-400">請求残高</p><p className="mt-1 font-bold tabular-nums text-blue-800">{formatYen(selectedOutstanding)}</p></div><div><p className="text-xs text-slate-400">請求日</p><p className="mt-1 font-semibold">{dateLabel(selectedInvoice.billingDate)}</p></div><div><p className="text-xs text-slate-400">支払期限</p><p className="mt-1 font-semibold">{dateLabel(selectedInvoice.paymentDueDate)}</p></div></div>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">入金日<input type="date" className="pm-input mt-2" disabled={!canEdit || busy !== ""} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label><label className="text-sm font-semibold">入金額<input inputMode="numeric" className="pm-input mt-2 text-right text-base font-bold tabular-nums" disabled={!canEdit || busy !== "" || selectedOutstanding <= 0} value={amountText} placeholder="0" onChange={(event) => setAmountText(moneyInput(numeric(event.target.value)))} /></label></div>
          <label className="block text-sm font-semibold">入金方法<select className="pm-input mt-2" disabled={!canEdit || busy !== ""} value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>{Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block text-sm font-semibold">振込名義・支払者<input className="pm-input mt-2" disabled={!canEdit || busy !== ""} value={payerName} placeholder={project.customerName || "支払者名"} onChange={(event) => setPayerName(event.target.value)} /></label>
          <label className="block text-sm font-semibold">振込番号・照合番号<input className="pm-input mt-2" disabled={!canEdit || busy !== ""} value={referenceNumber} placeholder="通帳摘要・取引番号など" onChange={(event) => setReferenceNumber(event.target.value)} /></label>
          <label className="block text-sm font-semibold">備考<textarea rows={3} className="pm-input mt-2 resize-y" disabled={!canEdit || busy !== ""} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <button type="button" className="pm-primary w-full justify-center" disabled={!canEdit || busy !== "" || !selectedInvoice || selectedOutstanding <= 0} onClick={() => void recordPayment()}><Save size={16} />{busy === "record" ? "登録中…" : "入金を登録"}</button>
        </div>}
      </div>

      <div className="pm-card overflow-hidden p-0">
        <div className="border-b border-slate-200 p-5"><h2 className="font-bold">請求別の入金状況</h2><p className="mt-1 text-xs text-slate-500">請求書ごとの入金済み額と残高を確認できます。</p></div>
        {issuedInvoices.length === 0 ? <div className="grid min-h-56 place-items-center p-6 text-sm text-slate-400">発行済み請求書がありません。</div> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">請求番号</th><th className="px-4 py-3 text-left">請求日 / 期限</th><th className="px-4 py-3 text-right">請求額</th><th className="px-4 py-3 text-right">入金済み</th><th className="px-4 py-3 text-right">残高</th><th className="px-4 py-3 text-center">状態</th></tr></thead><tbody className="divide-y divide-slate-100">{issuedInvoices.map((invoice) => {
          const paid = paidByInvoice[invoice.id] ?? 0;
          const balance = Math.max(0, invoice.total - paid);
          const overdue = balance > 0 && Boolean(invoice.paymentDueDate) && invoice.paymentDueDate < today();
          const label = balance <= 0 ? "入金済み" : paid > 0 ? "一部入金" : overdue ? "期限超過" : "未入金";
          const style = balance <= 0 ? "bg-emerald-50 text-emerald-700" : overdue ? "bg-red-50 text-red-700" : paid > 0 ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-800";
          return <tr key={invoice.id} className="hover:bg-slate-50/60"><td className="px-4 py-4"><p className="font-bold">{invoice.invoiceNumber}</p><p className="mt-1 max-w-64 truncate text-xs text-slate-400">{invoice.title}</p></td><td className="px-4 py-4"><p>{dateLabel(invoice.billingDate)}</p><p className={`mt-1 flex items-center gap-1 text-xs ${overdue ? "font-semibold text-red-600" : "text-slate-400"}`}><CalendarClock size={13} />{dateLabel(invoice.paymentDueDate)}</p></td><td className="px-4 py-4 text-right font-semibold tabular-nums">{formatYen(invoice.total)}</td><td className="px-4 py-4 text-right font-semibold tabular-nums text-blue-800">{formatYen(paid)}</td><td className="px-4 py-4 text-right font-bold tabular-nums">{formatYen(balance)}</td><td className="px-4 py-4 text-center"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${style}`}>{label}</span></td></tr>;
        })}</tbody></table></div>}
      </div>
    </section>

    <section className="pm-card overflow-hidden p-0">
      <div className="border-b border-slate-200 p-5"><h2 className="font-bold">入金履歴</h2><p className="mt-1 text-xs text-slate-500">取消後も記録を残し、必要な場合は復元できます。</p></div>
      {payments.length === 0 ? <div className="grid min-h-44 place-items-center p-6 text-sm text-slate-400">入金履歴はまだありません。</div> : <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">入金日</th><th className="px-4 py-3 text-left">請求番号</th><th className="px-4 py-3 text-left">方法・名義</th><th className="px-4 py-3 text-left">照合番号</th><th className="px-4 py-3 text-right">入金額</th><th className="px-4 py-3 text-center">状態</th><th className="px-4 py-3 text-center">操作</th></tr></thead><tbody className="divide-y divide-slate-100">{payments.map((payment) => <tr key={payment.id} className={payment.status === "cancelled" ? "bg-slate-50 text-slate-400" : "hover:bg-slate-50/60"}><td className="px-4 py-4 font-semibold">{dateLabel(payment.paymentDate)}</td><td className="px-4 py-4 font-bold">{payment.invoiceNumber}</td><td className="px-4 py-4"><p>{METHOD_LABELS[payment.method]}</p><p className="mt-1 text-xs text-slate-400">{payment.payerName || "名義未入力"}</p></td><td className="px-4 py-4">{payment.referenceNumber || "—"}</td><td className={`px-4 py-4 text-right font-bold tabular-nums ${payment.status === "cancelled" ? "line-through" : "text-blue-900"}`}>{formatYen(payment.amount)}</td><td className="px-4 py-4 text-center">{payment.status === "recorded" ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700"><CheckCircle2 size={13} />有効</span> : <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500"><CircleOff size={13} />取消済み</span>}</td><td className="px-4 py-4 text-center">{canEdit && (payment.status === "recorded" ? <button type="button" className="pm-secondary border-red-200 text-red-700 hover:bg-red-50" disabled={busy !== ""} onClick={() => void changeStatus(payment, "cancelled")}><CircleOff size={14} />取消</button> : <button type="button" className="pm-secondary" disabled={busy !== ""} onClick={() => void changeStatus(payment, "recorded")}><RotateCcw size={14} />復元</button>)}</td></tr>)}</tbody></table></div>}
    </section>
    {message && <p role="status" className={`rounded-xl p-4 text-sm ${message.includes("できません") || message.includes("超えて") ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-800"}`}>{message}</p>}
  </div>;
}
