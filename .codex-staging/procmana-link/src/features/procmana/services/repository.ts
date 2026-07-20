"use client";

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  Timestamp,
  writeBatch,
  type DocumentData,
} from "firebase/firestore";
import { deleteObject, getBlob, getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebaseClient";
import { estimateTotals, lineTotals } from "../calculations";
import { demoEstimates, demoProjects, demoMembership } from "../demo-data";
import type { ContractInput, EstimateHeaderInput, ProjectInput } from "../schemas";
import { FirestoreProcNovaService } from "./procnova";
import type {
  CompanyMembership,
  Customer,
  CompanySenderProfile,
  CostActuals,
  ExecutionBudgetLine,
  Invoice,
  InvoiceLine,
  InvoiceMilestone,
  InvoiceSettings,
  InvoiceStatus,
  BillingType,
  Payment,
  PaymentMethod,
  PaymentStatus,
  ProjectDocument,
  ProjectDocumentCategory,
  ProjectDocumentStatus,
  ProcNovaVaultDocument,
  ProcNovaVaultFolder,
  WorkTypeBilling,
  Estimate,
  EstimateLine,
  ManagementInvite,
  ManagementRole,
  PurchaseOrder,
  PurchaseOrderLine,
  Project,
  ProjectFinancials,
  ProjectMember,
  ProjectStatus,
  SiteRole,
} from "../types";

const DEMO_PROJECTS_KEY = "procmana.demo.projects.v2";
const DEMO_ESTIMATES_KEY = "procmana.demo.estimates.v2";
const DEMO_BUDGETS_KEY = "procmana.demo.budgets.v1";
const DEMO_PURCHASE_ORDERS_KEY = "procmana.demo.purchaseOrders.v1";
const DEMO_PURCHASE_ORDER_DRAFTS_KEY = "procmana.demo.purchaseOrderDrafts.v1";
const procNovaService = new FirestoreProcNovaService(db);
const PROJECT_LIST_CACHE_MS = 30_000;
const projectListCache = new Map<string, { expiresAt: number; projects: Project[] }>();

function invalidateProjectListCache(uid: string): void {
  projectListCache.delete(uid);
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function nullableText(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}
function iso(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return typeof value === "string" ? value : new Date(0).toISOString();
}
function nullableIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return typeof value === "string" && value ? value : null;
}
function projectStatus(value: unknown): ProjectStatus {
  const allowed: ProjectStatus[] = ["draft_estimate", "estimate_submitted", "negotiating", "lost", "contracted", "contract_cancelled", "budgeting", "ordering", "pre_construction", "in_progress", "completed", "final_invoiced", "paid", "closed"];
  return allowed.includes(value as ProjectStatus) ? value as ProjectStatus : "draft_estimate";
}
function managementRole(value: unknown): ManagementRole {
  return value === "owner" || value === "admin" || value === "accounting" ? value : "none";
}
function siteRole(value: unknown): SiteRole {
  return value === "owner" || value === "admin" || value === "member" ? value : "none";
}
function blankFinancials(): ProjectFinancials { return { estimateAmount: 0, contractAmount: 0, plannedCost: 0, actualCost: 0, invoicedAmount: 0, paidAmount: 0 }; }

function mapProject(id: string, data: DocumentData, financials: DocumentData | undefined, access: DocumentData | undefined): Project {
  const ownerUid = text(data.ownerUid);
  const status = projectStatus(data.status);
  const contractState = data.contractState === "active" || data.contractState === "cancelled"
    ? data.contractState
    : status === "contract_cancelled"
      ? "cancelled"
      : ["contracted", "budgeting", "ordering", "pre_construction", "in_progress", "completed", "final_invoiced", "paid", "closed"].includes(status)
        ? "active"
        : "none";
  return {
    id,
    companyId: text(data.companyId) || ownerUid,
    ownerUid,
    siteRole: siteRole(access?.siteRole),
    managementRole: ownerUid && access?.uid === ownerUid ? "owner" : managementRole(access?.managementRole),
    source: data.source === "procnova" ? "procnova" : "procmana",
    name: text(data.name),
    customerName: text(data.customerName),
    customerContact: text(data.customerContact),
    customerAddress: text(data.customerAddress),
    siteAddress: text(data.siteAddress),
    phone: text(data.phone),
    email: text(data.email),
    managerId: text(data.managerId),
    managerName: text(data.managerName),
    estimateDueDate: text(data.estimateDueDate),
    plannedStartDate: text(data.plannedStartDate),
    plannedEndDate: text(data.plannedEndDate),
    winProbability: number(data.winProbability),
    notes: text(data.notes),
    status,
    contractState,
    activeContractId: nullableText(data.activeContractId),
    lastContractId: nullableText(data.lastContractId),
    contractConfirmedAt: nullableIso(data.contractConfirmedAt),
    contractCancelledAt: nullableIso(data.contractCancelledAt),
    contractCancelledBy: nullableText(data.contractCancelledBy),
    constructionProgress: number(data.constructionProgress),
    billingProgress: number(data.billingProgress),
    procNovaProjectId: nullableText(data.procNovaProjectId),
    procNovaProjectUrl: nullableText(data.procNovaProjectUrl),
    procNovaLinkStatus: data.procNovaLinkStatus === "linked" || data.procNovaLinkStatus === "failed" ? data.procNovaLinkStatus : "not_linked",
    siteShareCode: nullableText(data.siteShareCode),
    budgetWorkTypeVendors: stringRecord(data.budgetWorkTypeVendors),
    budgetWorkTypeOrder: stringArray(data.budgetWorkTypeOrder),
    ...blankFinancials(),
    estimateAmount: number(financials?.estimateAmount),
    contractAmount: number(financials?.contractAmount),
    plannedCost: number(financials?.plannedCost),
    actualCost: number(financials?.actualCost),
    invoicedAmount: number(financials?.invoicedAmount),
    paidAmount: number(financials?.paidAmount),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function mapLine(value: unknown, index: number): EstimateLine {
  const data = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const base = { id: text(data.id) || `line-${index}`, parentId: nullableText(data.parentId), lineType: data.lineType === "heading" ? "heading" as const : "detail" as const, sortOrder: number(data.sortOrder), workType: text(data.workType), itemName: text(data.itemName), specification: text(data.specification), specNumber: text(data.specNumber), quantity: number(data.quantity), unit: text(data.unit), unitPrice: number(data.unitPrice), costUnitPrice: number(data.costUnitPrice), notes: text(data.notes), conversionRate: typeof data.conversionRate === "number" ? data.conversionRate : undefined };
  return { ...base, ...lineTotals(base) };
}

function mapEstimate(id: string, projectId: string, data: DocumentData): Estimate {
  const rateEntries = typeof data.workTypeCostRates === "object" && data.workTypeCostRates !== null
    ? Object.entries(data.workTypeCostRates as Record<string, unknown>).map(([key, value]) => [key, number(value)] as const)
    : [];
  return { id, companyId: text(data.companyId), projectId, estimateNumber: text(data.estimateNumber), estimateDate: text(data.estimateDate), validUntil: text(data.validUntil), subject: text(data.subject), paymentTerms: text(data.paymentTerms), notes: text(data.notes), defaultCostRate: typeof data.defaultCostRate === "number" ? data.defaultCostRate : 80, workTypeCostRates: Object.fromEntries(rateEntries), lines: Array.isArray(data.lines) ? data.lines.map(mapLine) : [], subtotal: number(data.subtotal), discount: number(data.discount), taxRate: number(data.taxRate), tax: number(data.tax), total: number(data.total), status: data.status === "submitted" || data.status === "adopted" ? data.status : "draft", version: number(data.version) || 1, createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt) };
}

function mapExecutionBudget(id: string, projectId: string, data: DocumentData): ExecutionBudgetLine {
  const budgetQuantity = number(data.budgetQuantity);
  const budgetUnitPrice = number(data.budgetUnitPrice);
  const budgetCost = Math.round(budgetQuantity * budgetUnitPrice);
  const actualCost = number(data.actualCost);
  return {
    id,
    projectId,
    sourceEstimateId: nullableText(data.sourceEstimateId),
    estimateLineId: nullableText(data.estimateLineId),
    sortOrder: typeof data.sortOrder === "number" && Number.isFinite(data.sortOrder) ? data.sortOrder : Number.MAX_SAFE_INTEGER,
    workType: text(data.workType),
    itemName: text(data.itemName),
    specification: text(data.specification),
    specNumber: text(data.specNumber),
    unit: text(data.unit),
    estimateQuantity: number(data.estimateQuantity) || budgetQuantity,
    estimateCostUnitPrice: number(data.estimateCostUnitPrice) || number(data.budgetUnitPrice),
    estimateCost: number(data.estimateCost) || number(data.budgetCost),
    budgetQuantity,
    budgetUnitPrice,
    budgetCost,
    plannedVendor: text(data.plannedVendor),
    orderedAmount: number(data.orderedAmount),
    actualCost,
    variance: budgetCost - actualCost,
    notes: text(data.notes),
    active: data.active !== false,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function mapPurchaseOrderLine(value: unknown, index: number): PurchaseOrderLine {
  const data = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const quantity = number(data.quantity);
  const unitPrice = number(data.unitPrice);
  return {
    id: text(data.id) || `order-line-${index}`,
    budgetLineId: text(data.budgetLineId),
    workType: text(data.workType),
    itemName: text(data.itemName),
    specification: text(data.specification),
    specNumber: text(data.specNumber),
    quantity,
    unit: text(data.unit),
    unitPrice,
    amount: Math.round(quantity * unitPrice),
    notes: text(data.notes),
  };
}

function mapPurchaseOrder(id: string, projectId: string, data: DocumentData): PurchaseOrder {
  const lines = Array.isArray(data.lines) ? data.lines.map(mapPurchaseOrderLine) : [];
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const taxRate = typeof data.taxRate === "number" ? data.taxRate : 10;
  const tax = Math.round(subtotal * taxRate / 100);
  return {
    id,
    projectId,
    companyId: text(data.companyId),
    ownerUid: text(data.ownerUid),
    vendorKey: text(data.vendorKey),
    vendorName: text(data.vendorName),
    orderNumber: text(data.orderNumber),
    status: data.status === "confirmed" || data.status === "cancelled" ? data.status : "draft",
    orderDate: text(data.orderDate),
    deliveryStartDate: text(data.deliveryStartDate),
    deliveryEndDate: text(data.deliveryEndDate),
    siteAddress: text(data.siteAddress),
    paymentTerms: text(data.paymentTerms),
    notes: text(data.notes),
    subtotal,
    taxRate,
    tax,
    total: subtotal + tax,
    lines,
    sourceBudgetSignature: text(data.sourceBudgetSignature),
    revisionOfOrderId: nullableText(data.revisionOfOrderId),
    lastConfirmedSignature: nullableText(data.lastConfirmedSignature),
    lastConfirmedOrderId: nullableText(data.lastConfirmedOrderId),
    version: number(data.version) || 1,
    active: data.active !== false,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    confirmedAt: nullableIso(data.confirmedAt),
    confirmedBy: nullableText(data.confirmedBy),
    cancelledAt: nullableIso(data.cancelledAt),
    cancellationReason: nullableText(data.cancellationReason),
  };
}

function readDemoProjects(): Project[] {
  const saved = window.localStorage.getItem(DEMO_PROJECTS_KEY);
  if (!saved) return demoProjects;
  try {
    return (JSON.parse(saved) as Project[]).map((project) => ({
      ...project,
      contractState: project.contractState ?? (project.status === "contracted" ? "active" : project.status === "contract_cancelled" ? "cancelled" : "none"),
      activeContractId: project.activeContractId ?? null,
      lastContractId: project.lastContractId ?? null,
      contractConfirmedAt: project.contractConfirmedAt ?? null,
      contractCancelledAt: project.contractCancelledAt ?? null,
      contractCancelledBy: project.contractCancelledBy ?? null,
      budgetWorkTypeVendors: project.budgetWorkTypeVendors ?? {},
      budgetWorkTypeOrder: project.budgetWorkTypeOrder ?? [],
    }));
  } catch { return demoProjects; }
}
function readDemoEstimates(): Record<string, Estimate[]> {
  const saved = window.localStorage.getItem(DEMO_ESTIMATES_KEY);
  if (!saved) return demoEstimates;
  try { return JSON.parse(saved) as Record<string, Estimate[]>; } catch { return demoEstimates; }
}
function readDemoBudgets(): Record<string, ExecutionBudgetLine[]> {
  const saved = window.localStorage.getItem(DEMO_BUDGETS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, ExecutionBudgetLine[]>; } catch { return {}; }
}
function readDemoPurchaseOrders(): Record<string, PurchaseOrder[]> {
  const saved = window.localStorage.getItem(DEMO_PURCHASE_ORDERS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, PurchaseOrder[]>; } catch { return {}; }
}
function readDemoPurchaseOrderDrafts(): Record<string, PurchaseOrder[]> {
  const saved = window.localStorage.getItem(DEMO_PURCHASE_ORDER_DRAFTS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, PurchaseOrder[]>; } catch { return {}; }
}

export async function loadMembership(uid: string, authProfile?: { displayName: string; email: string }): Promise<CompanyMembership> {
  const [memberSnap, userSnap, craftsmanSnap] = await Promise.all([
    getDoc(doc(db, "reNovaMember", uid)),
    getDoc(doc(db, "users", uid)),
    getDoc(doc(db, "craftsmen", uid)),
  ]);
  if (!memberSnap.exists() || memberSnap.data().procManaAccessEnabled !== true) {
    throw new Error("procmana_access_denied");
  }
  const memberData = memberSnap.data();
  const userData = userSnap.exists() ? userSnap.data() : {};
  const craftsmanData = craftsmanSnap.exists() ? craftsmanSnap.data() : {};
  const memberProfile = typeof memberData.profile === "object" && memberData.profile !== null ? memberData.profile as Record<string, unknown> : {};
  const displayName = authProfile?.displayName || text(memberProfile.fullName) || text(userData.displayName) || text(userData.name) || text(craftsmanData.name) || "ProcNovaユーザー";
  const companyName = text(memberProfile.companyName) || text(userData.company) || text(craftsmanData.company) || "ProcNova連携";
  return { uid, companyId: uid, companyName, displayName, email: authProfile?.email || text(memberData.email) || text(userData.email) || text(craftsmanData.email), role: "member", canManageUsers: false, allowedProjectIds: [], active: true };
}

export async function loadCompanySenderProfile(member: CompanyMembership, demo: boolean): Promise<CompanySenderProfile> {
  if (demo) return { companyName: member.companyName, companyAddress: "", phone: "", logoUrl: "", fullName: member.displayName, fax: "", registrationNumber: "", bankName: "", branchName: "", accountType: "普通", accountNumber: "", accountHolder: "" };
  const snapshot = await getDoc(doc(db, "reNovaMember", member.uid));
  const data = snapshot.exists() ? snapshot.data() : {};
  const profile = typeof data.profile === "object" && data.profile !== null ? data.profile as Record<string, unknown> : {};
  return {
    companyName: text(profile.companyName) || member.companyName,
    companyAddress: text(profile.companyAddress),
    phone: text(profile.phone),
    logoUrl: text(profile.profileLogoUrl),
    fullName: text(profile.fullName) || member.displayName,
    fax: text(profile.fax),
    registrationNumber: text(profile.invoiceRegistrationNumber),
    bankName: text(profile.invoiceBankName),
    branchName: text(profile.invoiceBranchName),
    accountType: text(profile.invoiceAccountType) || "普通",
    accountNumber: text(profile.invoiceAccountNumber),
    accountHolder: text(profile.invoiceAccountHolder),
  };
}

/** 会社ロゴをアップロードし、プロフィールのロゴURLを更新する（ProcNovaと共有） */
export async function uploadCompanyLogo(member: CompanyMembership, file: File, demo: boolean): Promise<string> {
  if (demo) throw new Error("デモモードではロゴを変更できません。");
  const ref = storageRef(storage, `reNovaMember/${member.uid}/profileLogo`);
  await uploadBytes(ref, file, { contentType: file.type });
  const url = await getDownloadURL(ref);
  const snapshot = await getDoc(doc(db, "reNovaMember", member.uid));
  const current = snapshot.exists() && typeof snapshot.data().profile === "object" && snapshot.data().profile !== null
    ? snapshot.data().profile as Record<string, unknown>
    : {};
  await setDoc(doc(db, "reNovaMember", member.uid), { profile: { ...current, profileLogoUrl: url }, updatedAt: serverTimestamp() }, { merge: true });
  return url;
}

/**
 * 請求書・発注書で使う自社情報をProcNovaのプロフィールへ保存する。
 * 会社（ログインユーザー）単位のため、一度設定すれば全工事で使い回せる。
 */
export async function saveCompanySenderProfile(member: CompanyMembership, profile: CompanySenderProfile, demo: boolean): Promise<void> {
  if (demo) throw new Error("デモモードでは自社情報を保存できません。");
  const snapshot = await getDoc(doc(db, "reNovaMember", member.uid));
  const current = snapshot.exists() && typeof snapshot.data().profile === "object" && snapshot.data().profile !== null
    ? snapshot.data().profile as Record<string, unknown>
    : {};
  await setDoc(doc(db, "reNovaMember", member.uid), {
    profile: {
      ...current,
      companyName: profile.companyName.trim(),
      companyAddress: profile.companyAddress.trim(),
      phone: profile.phone.trim(),
      fax: profile.fax.trim(),
      invoiceRegistrationNumber: profile.registrationNumber.trim(),
      invoiceBankName: profile.bankName.trim(),
      invoiceBranchName: profile.branchName.trim(),
      invoiceAccountType: profile.accountType.trim() || "普通",
      invoiceAccountNumber: profile.accountNumber.trim(),
      invoiceAccountHolder: profile.accountHolder.trim(),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

async function syncOwnedNovaProjects(member: CompanyMembership, knownAccessIds: ReadonlySet<string>): Promise<void> {
  const myProjects = await getDocs(collection(db, "users", member.uid, "myProjects"));
  const owned = myProjects.docs.filter((snapshot) => snapshot.data().role === "owner" && snapshot.data().revoked !== true && !knownAccessIds.has(snapshot.id));
  if (owned.length === 0) return;
  const batch = writeBatch(db);
  let writes = 0;
  const novaSnapshots = await Promise.all(owned.map((ownedProject) => getDoc(doc(db, "projects", ownedProject.id))));
  for (let index = 0; index < owned.length; index++) {
    const ownedProject = owned[index];
    const projectId = ownedProject.id;
    const accessRef = doc(db, "users", member.uid, "procManaProjects", projectId);
    const novaSnap = novaSnapshots[index];
    if (!novaSnap.exists()) continue;
    const nova = novaSnap.data();
    if (nova.ownerUid !== member.uid) continue;
    const projectRef = doc(db, "procmanaProjects", projectId);
    batch.set(projectRef, {
        id: projectId,
        companyId: member.uid,
        ownerUid: member.uid,
        name: text(nova.name) || text(ownedProject.data().name) || "名称未設定",
        customerName: text(nova.customerName),
        customerContact: "",
        customerAddress: "",
        siteAddress: text(nova.siteAddress) || text(nova.address),
        phone: "",
        email: "",
        managerId: member.uid,
        managerName: text(nova.ownerName) || member.displayName,
        estimateDueDate: "",
        plannedStartDate: text(nova.plannedStartDate),
        plannedEndDate: text(nova.plannedEndDate),
        winProbability: 100,
        notes: "ProcNovaからowner工事を自動取得",
        status: "contracted",
        contractState: "active",
        activeContractId: null,
        lastContractId: null,
        contractConfirmedAt: serverTimestamp(),
        contractCancelledAt: null,
        contractCancelledBy: null,
        constructionProgress: 0,
        billingProgress: 0,
        procNovaProjectId: projectId,
        procNovaProjectUrl: `${process.env.NEXT_PUBLIC_PROCNOVA_BASE_URL || "http://localhost:3000"}/proclink/projects/${projectId}`,
        procNovaLinkStatus: "linked",
        siteShareCode: text(nova.shareCode) || text(ownedProject.data().shareCode) || null,
        budgetWorkTypeVendors: {},
        budgetWorkTypeOrder: [],
        source: "procnova",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    batch.set(doc(projectRef, "private", "financials"), { companyId: member.uid, ownerUid: member.uid, ...blankFinancials(), updatedAt: serverTimestamp() }, { merge: true });
    writes += 2;
    const access = { uid: member.uid, projectId, projectName: text(nova.name), ownerUid: member.uid, siteRole: "owner", managementRole: "owner", source: "procnova_owner_sync", active: true, updatedAt: serverTimestamp() };
    batch.set(accessRef, access, { merge: true });
    batch.set(doc(projectRef, "members", member.uid), { ...access, displayName: member.displayName, email: member.email, joinedBy: "owner", createdAt: serverTimestamp() }, { merge: true });
    writes += 2;
  }
  if (writes > 0) {
    await batch.commit();
    invalidateProjectListCache(member.uid);
  }
}

export async function listProjects(member: CompanyMembership, demo: boolean): Promise<Project[]> {
  if (demo) return readDemoProjects();
  const cached = projectListCache.get(member.uid);
  if (cached && cached.expiresAt > Date.now()) return cached.projects;
  let accessSnapshots = await getDocs(collection(db, "users", member.uid, "procManaProjects"));
  const knownAccessIds = new Set(accessSnapshots.docs.map((snapshot) => snapshot.id));
  if (accessSnapshots.empty) {
    await syncOwnedNovaProjects(member, knownAccessIds);
    accessSnapshots = await getDocs(collection(db, "users", member.uid, "procManaProjects"));
  } else {
    void syncOwnedNovaProjects(member, knownAccessIds).catch(() => undefined);
  }
  const active = accessSnapshots.docs.filter((snapshot) => snapshot.data().active !== false && managementRole(snapshot.data().managementRole) !== "none");
  const rows = await Promise.all(active.map(async (accessSnap) => {
    const projectRef = doc(db, "procmanaProjects", accessSnap.id);
    const [projectSnap, financialSnap] = await Promise.all([getDoc(projectRef), getDoc(doc(projectRef, "private", "financials"))]);
    if (!projectSnap.exists()) return null;
    return mapProject(projectSnap.id, projectSnap.data(), financialSnap.exists() ? financialSnap.data() : undefined, accessSnap.data());
  }));
  const projects = rows.filter((row): row is Project => row !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  projectListCache.set(member.uid, { expiresAt: Date.now() + PROJECT_LIST_CACHE_MS, projects });
  return projects;
}

export async function getProject(member: CompanyMembership, projectId: string, demo: boolean): Promise<Project | null> {
  if (demo) return readDemoProjects().find((project) => project.id === projectId) ?? null;
  const projectRef = doc(db, "procmanaProjects", projectId);
  const [projectSnap, accessSnap, financialSnap] = await Promise.all([getDoc(projectRef), getDoc(doc(db, "users", member.uid, "procManaProjects", projectId)), getDoc(doc(projectRef, "private", "financials"))]);
  if (!projectSnap.exists()) return null;
  const ownerUid = text(projectSnap.data().ownerUid);
  if (ownerUid !== member.uid && (!accessSnap.exists() || accessSnap.data().active === false || managementRole(accessSnap.data().managementRole) === "none")) return null;
  const access = accessSnap.exists() ? accessSnap.data() : { uid: member.uid, siteRole: "owner", managementRole: "owner" };
  return mapProject(projectId, projectSnap.data(), financialSnap.exists() ? financialSnap.data() : undefined, access);
}

function dedupeKey(input: ProjectInput): string {
  const value = `${input.name}|${input.customerName}|${input.plannedStartDate}`.toLowerCase();
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export async function createProject(member: CompanyMembership, input: ProjectInput, demo: boolean): Promise<string> {
  const projectId = demo ? `project-${crypto.randomUUID()}` : doc(collection(db, "procmanaProjects")).id;
  const now = new Date().toISOString();
  const project: Project = { id: projectId, companyId: member.uid, ownerUid: member.uid, siteRole: "owner", managementRole: "owner", source: "procmana", ...input, status: "draft_estimate", contractState: "none", activeContractId: null, lastContractId: null, contractConfirmedAt: null, contractCancelledAt: null, contractCancelledBy: null, ...blankFinancials(), constructionProgress: 0, billingProgress: 0, procNovaProjectId: null, procNovaProjectUrl: null, procNovaLinkStatus: "not_linked", siteShareCode: null, budgetWorkTypeVendors: {}, budgetWorkTypeOrder: [], createdAt: now, updatedAt: now };
  if (demo) {
    const projects = readDemoProjects();
    if (projects.some((item) => dedupeKey(item) === dedupeKey(input))) throw new Error("同じ工事が既に登録されています。");
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify([project, ...projects]));
    return projectId;
  }
  const projectRef = doc(db, "procmanaProjects", projectId);
  const keyRef = doc(db, "users", member.uid, "procManaCreateKeys", dedupeKey(input));
  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(keyRef);
    if (existing.exists()) throw new Error("同じ工事が既に登録されています。");
    const { estimateAmount, contractAmount, plannedCost, actualCost, invoicedAmount, paidAmount, siteRole: _siteRole, managementRole: _managementRole, ...stored } = project;
    void _siteRole; void _managementRole;
    transaction.set(projectRef, { ...stored, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    transaction.set(doc(projectRef, "private", "financials"), { companyId: member.uid, ownerUid: member.uid, estimateAmount, contractAmount, plannedCost, actualCost, invoicedAmount, paidAmount, updatedAt: serverTimestamp() });
    const access = { uid: member.uid, projectId, projectName: project.name, ownerUid: member.uid, siteRole: "owner", managementRole: "owner", source: "procmana_create", active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    transaction.set(doc(db, "users", member.uid, "procManaProjects", projectId), access);
    transaction.set(doc(projectRef, "members", member.uid), { ...access, displayName: member.displayName, email: member.email, joinedBy: "owner" });
    transaction.set(keyRef, { projectId, ownerUid: member.uid, createdAt: serverTimestamp() });
  });
  invalidateProjectListCache(member.uid);
  return projectId;
}

export async function updateProjectBasicInfo(member: CompanyMembership, project: Project, input: ProjectInput, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("工事基本情報を編集する権限がありません。");
  const now = new Date().toISOString();
  if (demo) {
    const projects = readDemoProjects();
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(projects.map((item) => item.id === project.id ? { ...item, ...input, updatedAt: now } : item)));
    return;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  batch.update(projectRef, { ...input, updatedAt: serverTimestamp() });
  batch.set(doc(db, "users", member.uid, "procManaProjects", project.id), { projectName: input.name, updatedAt: serverTimestamp() }, { merge: true });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: "project.updated", actorUid: member.uid, actorName: member.displayName, targetId: project.id, after: { name: input.name, customerName: input.customerName, siteAddress: input.siteAddress }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
}

export async function listEstimates(_member: CompanyMembership, projectId: string, demo: boolean): Promise<Estimate[]> {
  if (demo) return readDemoEstimates()[projectId] ?? [];
  const snapshots = await getDocs(query(collection(db, "procmanaProjects", projectId, "estimates"), orderBy("updatedAt", "desc")));
  return snapshots.docs.map((snapshot) => mapEstimate(snapshot.id, projectId, snapshot.data()));
}

export async function listExecutionBudget(projectId: string, demo: boolean): Promise<ExecutionBudgetLine[]> {
  if (demo) return readDemoBudgets()[projectId] ?? [];
  const snapshots = await getDocs(collection(db, "procmanaProjects", projectId, "budgets"));
  return snapshots.docs
    .map((snapshot) => mapExecutionBudget(snapshot.id, projectId, snapshot.data()))
    // 見積明細から継承した sortOrder 順（未設定の旧データは末尾で品名順）
    .sort((a, b) => a.sortOrder - b.sortOrder || a.itemName.localeCompare(b.itemName, "ja"));
}

export function effectiveBudgetVendor(line: ExecutionBudgetLine, workTypeVendors: Record<string, string>): string {
  return line.plannedVendor.trim() || (workTypeVendors[line.workType] ?? "").trim();
}

function normalizeVendorKey(vendorName: string): string {
  return vendorName.trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
}

function stableHash(value: string, seed = 2166136261): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function purchaseOrderDraftId(vendorKey: string): string {
  return `vendor-${stableHash(vendorKey)}-${stableHash([...vendorKey].reverse().join(""), 3339675911)}`;
}

function purchaseOrderLinesFromBudget(lines: ExecutionBudgetLine[]): PurchaseOrderLine[] {
  return lines.map((line) => ({
    id: `order-line-${line.id}`,
    budgetLineId: line.id,
    workType: line.workType,
    itemName: line.itemName,
    specification: line.specification,
    specNumber: line.specNumber,
    quantity: line.budgetQuantity,
    unit: line.unit,
    unitPrice: line.budgetUnitPrice,
    amount: Math.round(line.budgetQuantity * line.budgetUnitPrice),
    notes: line.notes,
  }));
}

function purchaseOrderSignature(vendorKey: string, lines: PurchaseOrderLine[]): string {
  const source = JSON.stringify({ vendorKey, lines: lines.map((line) => [line.budgetLineId, line.workType, line.itemName, line.specification, line.specNumber, line.quantity, line.unit, line.unitPrice, line.notes]) });
  return `${stableHash(source)}-${stableHash([...source].reverse().join(""), 3339675911)}-${source.length}`;
}

export async function listPurchaseOrders(projectId: string, demo: boolean): Promise<PurchaseOrder[]> {
  if (demo) {
    const drafts = (readDemoPurchaseOrderDrafts()[projectId] ?? []).filter((order) => order.active);
    const confirmed = (readDemoPurchaseOrders()[projectId] ?? []).filter((order) => order.status !== "cancelled");
    return [...drafts, ...confirmed].sort((a, b) => Number(a.status !== "draft") - Number(b.status !== "draft") || b.updatedAt.localeCompare(a.updatedAt));
  }
  const projectRef = doc(db, "procmanaProjects", projectId);
  const [draftSnapshots, orderSnapshots] = await Promise.all([
    getDocs(collection(projectRef, "purchaseOrderDrafts")),
    getDocs(collection(projectRef, "purchaseOrders")),
  ]);
  const drafts = draftSnapshots.docs.map((snapshot) => mapPurchaseOrder(snapshot.id, projectId, snapshot.data())).filter((order) => order.active);
  const confirmed = orderSnapshots.docs.map((snapshot) => mapPurchaseOrder(snapshot.id, projectId, snapshot.data())).filter((order) => order.status !== "cancelled");
  return [...drafts, ...confirmed].sort((a, b) => Number(a.status !== "draft") - Number(b.status !== "draft") || b.updatedAt.localeCompare(a.updatedAt));
}

export function buildExecutionBudgetFromEstimate(
  projectId: string,
  estimate: Estimate,
  existing: ExecutionBudgetLine[],
): ExecutionBudgetLine[] {
  const sourceLines = estimate.lines.filter((line) => line.parentId !== null && line.lineType === "detail" && line.itemName.trim() !== "");
  const sourceIds = new Set(sourceLines.map((line) => line.id));
  // 表示順は見積全体（見出し行含む）の行位置を使う。実行予算側で区分見出しを同じ位置に差し込むため
  const indexById = new Map(estimate.lines.map((line, index) => [line.id, index] as const));
  const existingByLine = new Map(existing.filter((line) => line.estimateLineId).map((line) => [line.estimateLineId, line] as const));
  const retained = existing
    .filter((line) => !line.estimateLineId || !sourceIds.has(line.estimateLineId))
    .map((line) => line.estimateLineId ? { ...line, active: false } : line);
  const reflected = sourceLines.map((line, index): ExecutionBudgetLine => {
    const current = existingByLine.get(line.id);
    const budgetQuantity = line.quantity;
    const budgetUnitPrice = line.costUnitPrice;
    const budgetCost = Math.round(budgetQuantity * budgetUnitPrice);
    const actualCost = current?.actualCost ?? 0;
    return {
      id: current?.id ?? line.id,
      projectId,
      sourceEstimateId: estimate.id,
      estimateLineId: line.id,
      // 見積明細の並び順をそのまま実行予算の表示順として継承する
      sortOrder: indexById.get(line.id) ?? index,
      workType: line.workType,
      itemName: line.itemName,
      specification: line.specification,
      specNumber: line.specNumber,
      unit: line.unit,
      estimateQuantity: line.quantity,
      estimateCostUnitPrice: line.costUnitPrice,
      estimateCost: line.costAmount,
      budgetQuantity,
      budgetUnitPrice,
      budgetCost,
      plannedVendor: current?.plannedVendor ?? "",
      orderedAmount: current?.orderedAmount ?? 0,
      actualCost,
      variance: budgetCost - actualCost,
      notes: current?.notes || line.notes,
      active: true,
      createdAt: current?.createdAt ?? "",
      updatedAt: new Date().toISOString(),
    };
  });
  return [...retained, ...reflected];
}

async function syncPurchaseOrderDrafts(
  project: Project,
  lines: ExecutionBudgetLine[],
  workTypeVendors: Record<string, string>,
  demo: boolean,
): Promise<void> {
  const grouped = new Map<string, { vendorName: string; lines: ExecutionBudgetLine[] }>();
  lines.filter((line) => line.active && line.itemName.trim() !== "").forEach((line) => {
    const vendorName = effectiveBudgetVendor(line, workTypeVendors);
    if (!vendorName) return;
    const vendorKey = normalizeVendorKey(vendorName);
    const current = grouped.get(vendorKey) ?? { vendorName, lines: [] };
    current.lines.push(line);
    grouped.set(vendorKey, current);
  });

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  if (demo) {
    const allDrafts = readDemoPurchaseOrderDrafts();
    const existing = allDrafts[project.id] ?? [];
    const byId = new Map(existing.map((order) => [order.id, order] as const));
    const activeIds = new Set<string>();
    grouped.forEach((group, vendorKey) => {
      const id = purchaseOrderDraftId(vendorKey);
      activeIds.add(id);
      const current = byId.get(id);
      const orderLines = purchaseOrderLinesFromBudget(group.lines);
      const signature = purchaseOrderSignature(vendorKey, orderLines);
      if (current?.lastConfirmedSignature === signature) {
        if (current.active) byId.set(id, { ...current, active: false, updatedAt: now, cancelledAt: now, cancellationReason: "same_as_confirmed_order" });
        return;
      }
      if (current?.active && current.sourceBudgetSignature === signature) return;
      const subtotal = orderLines.reduce((sum, line) => sum + line.amount, 0);
      const taxRate = current?.taxRate ?? 10;
      const tax = Math.round(subtotal * taxRate / 100);
      byId.set(id, {
        id, projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
        vendorKey, vendorName: group.vendorName, orderNumber: "", status: "draft",
        orderDate: current?.orderDate || today, deliveryStartDate: current?.deliveryStartDate || project.plannedStartDate,
        deliveryEndDate: current?.deliveryEndDate || project.plannedEndDate, siteAddress: current?.siteAddress || project.siteAddress,
        paymentTerms: current?.paymentTerms || "月末締め翌月末払い", notes: current?.notes || "",
        subtotal, taxRate, tax, total: subtotal + tax, lines: orderLines, sourceBudgetSignature: signature,
        revisionOfOrderId: current?.lastConfirmedOrderId ?? null, lastConfirmedSignature: current?.lastConfirmedSignature ?? null,
        lastConfirmedOrderId: current?.lastConfirmedOrderId ?? null, version: (current?.version ?? 0) + 1,
        active: true, createdAt: current?.createdAt || now, updatedAt: now, confirmedAt: null, confirmedBy: null,
        cancelledAt: null, cancellationReason: null,
      });
    });
    byId.forEach((order, id) => {
      if (order.active && !activeIds.has(id)) byId.set(id, { ...order, active: false, updatedAt: now, cancelledAt: now, cancellationReason: "budget_vendor_removed" });
    });
    allDrafts[project.id] = [...byId.values()];
    window.localStorage.setItem(DEMO_PURCHASE_ORDER_DRAFTS_KEY, JSON.stringify(allDrafts));
    return;
  }

  const projectRef = doc(db, "procmanaProjects", project.id);
  const snapshots = await getDocs(collection(projectRef, "purchaseOrderDrafts"));
  const existing = new Map(snapshots.docs.map((snapshot) => [snapshot.id, mapPurchaseOrder(snapshot.id, project.id, snapshot.data())] as const));
  const activeIds = new Set<string>();
  const changes: Array<{ id: string; payload: Record<string, unknown>; create: boolean }> = [];
  grouped.forEach((group, vendorKey) => {
    const id = purchaseOrderDraftId(vendorKey);
    activeIds.add(id);
    const current = existing.get(id);
    const orderLines = purchaseOrderLinesFromBudget(group.lines);
    const signature = purchaseOrderSignature(vendorKey, orderLines);
    if (current?.lastConfirmedSignature === signature) {
      if (current.active) changes.push({ id, create: false, payload: { active: false, cancelledAt: serverTimestamp(), cancellationReason: "same_as_confirmed_order" } });
      return;
    }
    if (current?.active && current.sourceBudgetSignature === signature) return;
    const subtotal = orderLines.reduce((sum, line) => sum + line.amount, 0);
    const taxRate = current?.taxRate ?? 10;
    const tax = Math.round(subtotal * taxRate / 100);
    changes.push({ id, create: !current, payload: {
      projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
      vendorKey, vendorName: group.vendorName, orderNumber: "", status: "draft",
      orderDate: current?.orderDate || today, deliveryStartDate: current?.deliveryStartDate || project.plannedStartDate,
      deliveryEndDate: current?.deliveryEndDate || project.plannedEndDate, siteAddress: current?.siteAddress || project.siteAddress,
      paymentTerms: current?.paymentTerms || "月末締め翌月末払い", notes: current?.notes || "",
      subtotal, taxRate, tax, total: subtotal + tax, lines: orderLines, sourceBudgetSignature: signature,
      revisionOfOrderId: current?.lastConfirmedOrderId ?? null, lastConfirmedSignature: current?.lastConfirmedSignature ?? null,
      lastConfirmedOrderId: current?.lastConfirmedOrderId ?? null, version: (current?.version ?? 0) + 1,
      active: true, confirmedAt: null, confirmedBy: null, cancelledAt: null, cancellationReason: null,
    } });
  });
  existing.forEach((order, id) => {
    if (order.active && !activeIds.has(id)) changes.push({ id, create: false, payload: { active: false, cancelledAt: serverTimestamp(), cancellationReason: "budget_vendor_removed" } });
  });
  for (let offset = 0; offset < changes.length; offset += 400) {
    const batch = writeBatch(db);
    changes.slice(offset, offset + 400).forEach((change) => batch.set(doc(projectRef, "purchaseOrderDrafts", change.id), {
      ...change.payload,
      ...(change.create ? { createdAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(),
    }, { merge: true }));
    await batch.commit();
  }
}

export async function saveExecutionBudget(
  member: CompanyMembership,
  project: Project,
  lines: ExecutionBudgetLine[],
  workTypeVendors: Record<string, string>,
  workTypeOrder: string[],
  demo: boolean,
  options: { silent?: boolean } = {},
): Promise<number> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("実行予算を更新する権限がありません。");
  const normalized = lines.map((line) => {
    const budgetQuantity = Number.isFinite(line.budgetQuantity) ? line.budgetQuantity : 0;
    const budgetUnitPrice = Number.isFinite(line.budgetUnitPrice) ? line.budgetUnitPrice : 0;
    const budgetCost = Math.round(budgetQuantity * budgetUnitPrice);
    return { ...line, budgetQuantity, budgetUnitPrice, budgetCost, variance: budgetCost - line.actualCost };
  });
  const normalizedWorkTypeVendors = Object.fromEntries(Object.entries(workTypeVendors ?? {})
    .map(([workType, vendor]) => [workType.trim(), vendor.trim()] as const)
    .filter(([workType, vendor]) => workType !== "" && vendor !== ""));
  const normalizedWorkTypeOrder = [...new Set((workTypeOrder ?? []).map((workType) => workType.trim()).filter(Boolean))];
  const plannedCost = normalized.filter((line) => line.active).reduce((sum, line) => sum + line.budgetCost, 0);
  if (demo) {
    const budgets = readDemoBudgets();
    budgets[project.id] = normalized;
    window.localStorage.setItem(DEMO_BUDGETS_KEY, JSON.stringify(budgets));
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, plannedCost, budgetWorkTypeVendors: normalizedWorkTypeVendors, budgetWorkTypeOrder: normalizedWorkTypeOrder, updatedAt: new Date().toISOString() } : item)));
    await syncPurchaseOrderDrafts(project, normalized, normalizedWorkTypeVendors, true);
    return plannedCost;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  for (let offset = 0; offset < normalized.length; offset += 400) {
    const batch = writeBatch(db);
    normalized.slice(offset, offset + 400).forEach((line) => {
      const stored: Partial<ExecutionBudgetLine> = { ...line };
      delete stored.createdAt;
      delete stored.updatedAt;
      batch.set(doc(projectRef, "budgets", line.id), {
        ...stored,
        ownerUid: project.ownerUid,
        updatedAt: serverTimestamp(),
        ...(!line.createdAt || line.createdAt === new Date(0).toISOString() ? { createdAt: serverTimestamp() } : {}),
      }, { merge: true });
    });
    await batch.commit();
  }
  const summaryBatch = writeBatch(db);
  summaryBatch.update(projectRef, { budgetWorkTypeVendors: normalizedWorkTypeVendors, budgetWorkTypeOrder: normalizedWorkTypeOrder, updatedAt: serverTimestamp() });
  summaryBatch.set(doc(projectRef, "private", "financials"), { plannedCost, updatedAt: serverTimestamp() }, { merge: true });
  // 自動保存（silent）では操作ログを書かない
  if (!options.silent) summaryBatch.set(doc(collection(projectRef, "activityLogs")), { action: "budget.updated", actorUid: member.uid, actorName: member.displayName, after: { plannedCost, activeLines: normalized.filter((line) => line.active).length, workTypeVendorDefaults: Object.keys(normalizedWorkTypeVendors).length }, createdAt: serverTimestamp() });
  await summaryBatch.commit();
  await syncPurchaseOrderDrafts(project, normalized, normalizedWorkTypeVendors, demo);
  invalidateProjectListCache(member.uid);
  return plannedCost;
}

const DEMO_COST_ACTUALS_KEY = "procmana.demo.costActuals.v1";

function readDemoCostActuals(): Record<string, CostActuals> {
  const saved = window.localStorage.getItem(DEMO_COST_ACTUALS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, CostActuals>; } catch { return {}; }
}

function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, Number(raw) || 0] as const));
}

function monthlyMap(value: unknown): Record<string, Record<string, number>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([month, map]) => [month, numberMap(map)] as const));
}

export async function loadCostActuals(projectId: string, demo: boolean): Promise<CostActuals> {
  if (demo) {
    const saved = readDemoCostActuals()[projectId];
    return { mode: saved?.mode === "vendor" ? "vendor" : "workType", workType: saved?.workType ?? {}, vendor: saved?.vendor ?? {}, monthly: saved?.monthly ?? {} };
  }
  const snapshot = await getDoc(doc(db, "procmanaProjects", projectId, "private", "financials"));
  const data = snapshot.exists() ? snapshot.data() : {};
  return {
    mode: data.costActualMode === "vendor" ? "vendor" : "workType",
    workType: numberMap(data.workTypeActualCosts),
    vendor: numberMap(data.vendorActualCosts),
    monthly: monthlyMap(data.costMonthlyActuals),
  };
}

export async function saveCostActuals(member: CompanyMembership, project: Project, actuals: CostActuals, demo: boolean, options: { silent?: boolean } = {}): Promise<number> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("実績原価を更新する権限がありません。");
  const normalize = (map: Record<string, number>) => Object.fromEntries(Object.entries(map)
    .map(([key, value]) => [key.trim(), Number.isFinite(value) ? Math.round(value) : 0] as const)
    .filter(([key, value]) => key !== "" && value !== 0));
  const workType = normalize(actuals.workType);
  const vendor = normalize(actuals.vendor);
  const monthly = Object.fromEntries(Object.entries(actuals.monthly ?? {})
    .map(([month, map]) => [month.trim(), normalize(map)] as const)
    .filter(([month, map]) => /^\d{4}-\d{2}$/.test(month) && Object.keys(map).length > 0));
  const activeMap = actuals.mode === "vendor" ? vendor : workType;
  const actualTotal = Object.values(activeMap).reduce((sum, value) => sum + value, 0);
  const now = new Date().toISOString();
  if (demo) {
    const all = readDemoCostActuals();
    all[project.id] = { mode: actuals.mode, workType, vendor, monthly };
    window.localStorage.setItem(DEMO_COST_ACTUALS_KEY, JSON.stringify(all));
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, actualCost: actualTotal, updatedAt: now } : item)));
    return actualTotal;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  batch.set(doc(projectRef, "private", "financials"), { costActualMode: actuals.mode, workTypeActualCosts: workType, vendorActualCosts: vendor, costMonthlyActuals: monthly, actualCost: actualTotal, updatedAt: serverTimestamp() }, { merge: true });
  // 自動保存（silent）では操作ログを書かず、書き込みを財務サマリー1件に抑える
  if (!options.silent) batch.set(doc(collection(projectRef, "activityLogs")), { action: "costs.updated", actorUid: member.uid, actorName: member.displayName, after: { actualCost: actualTotal, mode: actuals.mode, entries: Object.keys(activeMap).length }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
  return actualTotal;
}

const DEMO_WORKTYPE_PROGRESS_KEY = "procmana.demo.workTypeProgress.v1";

function readDemoWorkTypeProgress(): Record<string, Record<string, number>> {
  const saved = window.localStorage.getItem(DEMO_WORKTYPE_PROGRESS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, Record<string, number>>; } catch { return {}; }
}

const DEMO_NOVA_PROGRESS_MAP_KEY = "procmana.demo.novaProgressMap.v1";

function readDemoNovaProgressMap(): Record<string, Record<string, string>> {
  const saved = window.localStorage.getItem(DEMO_NOVA_PROGRESS_MAP_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, Record<string, string>>; } catch { return {}; }
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const DEMO_WORKTYPE_PROGRESS_MONTHLY_KEY = "procmana.demo.workTypeProgressMonthly.v1";

function readDemoWorkTypeProgressMonthly(): Record<string, Record<string, Record<string, number>>> {
  const saved = window.localStorage.getItem(DEMO_WORKTYPE_PROGRESS_MONTHLY_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, Record<string, Record<string, number>>>; } catch { return {}; }
}

function clampPercentMap(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(numberMap(value)).map(([key, raw]) => [key, Math.min(100, Math.max(0, raw))] as const));
}

export type WorkTypeProgressData = {
  /** 月末時点の累計進捗率スナップショット。キーは "YYYY-MM" */
  monthly: Record<string, Record<string, number>>;
  /** ProcNova工種名 → ProcMana工種名（空文字は対象外） */
  novaMap: Record<string, string>;
  /** ProcNova工種名 → 設定済み工程数。0＝ProcNovaで工程が未設定 */
  novaStepCounts: Record<string, number>;
  /** ProcNova工種名 → 工程未設定の工区名（「2工区・3工区」形式）。空文字＝全工区設定済み */
  novaUnsetAreas: Record<string, string>;
};

export async function loadWorkTypeProgress(projectId: string, demo: boolean): Promise<WorkTypeProgressData> {
  const seedMonth = new Date().toISOString().slice(0, 7);
  if (demo) {
    const monthly = readDemoWorkTypeProgressMonthly()[projectId] ?? {};
    const flat = readDemoWorkTypeProgress()[projectId] ?? {};
    return {
      monthly: Object.keys(monthly).length > 0 ? monthly : Object.keys(flat).length > 0 ? { [seedMonth]: flat } : {},
      novaMap: readDemoNovaProgressMap()[projectId] ?? {},
      novaStepCounts: {},
      novaUnsetAreas: {},
    };
  }
  const snapshot = await getDoc(doc(db, "procmanaProjects", projectId, "private", "financials"));
  const data = snapshot.exists() ? snapshot.data() : {};
  const monthlyRaw = typeof data.workTypeProgressMonthly === "object" && data.workTypeProgressMonthly !== null
    ? Object.fromEntries(Object.entries(data.workTypeProgressMonthly as Record<string, unknown>).map(([month, map]) => [month, clampPercentMap(map)] as const))
    : {};
  const flat = clampPercentMap(data.workTypeProgress);
  return {
    // 月別データがまだ無い既存工事は、従来の累計値を今月のスナップショットとして引き継ぐ
    monthly: Object.keys(monthlyRaw).length > 0 ? monthlyRaw : Object.keys(flat).length > 0 ? { [seedMonth]: flat } : {},
    novaMap: stringMap(data.novaProgressMap),
    novaStepCounts: numberMap(data.novaStepCounts),
    novaUnsetAreas: stringMap(data.novaUnsetAreas),
  };
}

export async function saveNovaProgressMap(member: CompanyMembership, project: Project, novaMap: Record<string, string>, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("反映先の設定を更新する権限がありません。");
  const normalized = Object.fromEntries(Object.entries(novaMap)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key]) => key !== ""));
  if (demo) {
    const all = readDemoNovaProgressMap();
    all[project.id] = normalized;
    window.localStorage.setItem(DEMO_NOVA_PROGRESS_MAP_KEY, JSON.stringify(all));
    return;
  }
  await setDoc(doc(db, "procmanaProjects", project.id, "private", "financials"), { novaProgressMap: normalized, updatedAt: serverTimestamp() }, { merge: true });
}

/** ProcNovaから取得した工種ごとの工程数を保存する（工程未設定の可視化に使う） */
export async function saveNovaStepCounts(project: Project, counts: Record<string, number>, unsetAreas: Record<string, string>, demo: boolean): Promise<void> {
  if (demo) return;
  if (project.managementRole !== "owner" && project.managementRole !== "admin") return;
  const normalized = Object.fromEntries(Object.entries(counts).map(([workType, value]) => [workType.trim(), Math.max(0, Math.round(value))] as const).filter(([workType]) => workType !== ""));
  const areas = Object.fromEntries(Object.entries(unsetAreas).map(([workType, value]) => [workType.trim(), value.trim()] as const).filter(([workType]) => workType !== ""));
  await setDoc(doc(db, "procmanaProjects", project.id, "private", "financials"), { novaStepCounts: normalized, novaUnsetAreas: areas, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveWorkTypeProgress(member: CompanyMembership, project: Project, monthly: Record<string, Record<string, number>>, overallProgress: number, demo: boolean, options: { silent?: boolean } = {}): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("出来高を更新する権限がありません。");
  const normalizeMap = (map: Record<string, number>) => Object.fromEntries(Object.entries(map)
    .map(([workType, value]) => [workType.trim(), Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))] as const)
    .filter(([workType, value]) => workType !== "" && value !== 0));
  const normalizedMonthly = Object.fromEntries(Object.entries(monthly)
    .map(([month, map]) => [month.trim(), normalizeMap(map)] as const)
    .filter(([month, map]) => /^\d{4}-\d{2}$/.test(month) && Object.keys(map).length > 0));
  // 概要タブ等で使う「最新の累計」は、最も新しい月のスナップショットを採用する
  const latestKey = Object.keys(normalizedMonthly).sort().pop() ?? null;
  const latestFlat = latestKey ? normalizedMonthly[latestKey] : {};
  const overall = Math.min(100, Math.max(0, Number.isFinite(overallProgress) ? Math.round(overallProgress * 10) / 10 : 0));
  const now = new Date().toISOString();
  if (demo) {
    const allMonthly = readDemoWorkTypeProgressMonthly();
    allMonthly[project.id] = normalizedMonthly;
    window.localStorage.setItem(DEMO_WORKTYPE_PROGRESS_MONTHLY_KEY, JSON.stringify(allMonthly));
    const allFlat = readDemoWorkTypeProgress();
    allFlat[project.id] = latestFlat;
    window.localStorage.setItem(DEMO_WORKTYPE_PROGRESS_KEY, JSON.stringify(allFlat));
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, constructionProgress: overall, updatedAt: now } : item)));
    return;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  batch.set(doc(projectRef, "private", "financials"), { workTypeProgressMonthly: normalizedMonthly, workTypeProgress: latestFlat, updatedAt: serverTimestamp() }, { merge: true });
  batch.update(projectRef, { constructionProgress: overall, updatedAt: serverTimestamp() });
  // 自動保存（silent）では操作ログを書かない
  if (!options.silent) batch.set(doc(collection(projectRef, "activityLogs")), { action: "progress.updated", actorUid: member.uid, actorName: member.displayName, after: { constructionProgress: overall, months: Object.keys(normalizedMonthly).length }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
}

export type SharedBudgetStatus = {
  includeAmounts: boolean;
  sharedAt: string;
  sharedByName: string;
  lineCount: number;
};

export async function loadSharedBudgetStatus(novaProjectId: string): Promise<SharedBudgetStatus | null> {
  const snapshot = await getDoc(doc(db, "projects", novaProjectId, "sharedBudget", "current"));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    includeAmounts: data.includeAmounts === true,
    sharedAt: iso(data.sharedAt),
    sharedByName: text(data.sharedByName),
    lineCount: Array.isArray(data.rows) ? data.rows.length : 0,
  };
}

/**
 * 実行予算の明細書をProcNova（現場管理者向け）へ共有する。
 * includeAmounts=false（金抜き）では数量明細のみ、true（金入り）では予算単価・金額・予定業者も含める。
 */
export async function shareBudgetDetailToProcNova(
  member: CompanyMembership,
  project: Project,
  lines: ExecutionBudgetLine[],
  workTypeVendors: Record<string, string>,
  workTypeOrder: string[],
  includeAmounts: boolean,
  demo: boolean,
): Promise<number> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("明細書を共有する権限がありません。");
  if (demo) throw new Error("デモモードではProcNovaへの共有はできません。");
  if (project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) throw new Error("ProcNova未連携です。契約タブで契約を確定すると共有できます。");
  const activeLines = lines.filter((line) => line.active && line.itemName.trim() !== "");
  const orderedWorkTypes = orderedActiveWorkTypes(activeLines, workTypeOrder);
  const workTypeIndex = new Map(orderedWorkTypes.map((workType, index) => [workType, index] as const));
  const rows = [...activeLines]
    // 金抜き共有では金額専用の端数調整行は意味を持たないため除外する
    .filter((line) => includeAmounts || line.itemName.trim() !== "端数調整")
    .sort((a, b) => (workTypeIndex.get(a.workType.trim()) ?? 999) - (workTypeIndex.get(b.workType.trim()) ?? 999) || a.sortOrder - b.sortOrder)
    .map((line) => ({
      workType: line.workType,
      itemName: line.itemName,
      specification: line.specification,
      specNumber: line.specNumber,
      quantity: line.budgetQuantity,
      unit: line.unit,
      ...(includeAmounts ? {
        unitPrice: line.budgetUnitPrice,
        amount: Math.round(line.budgetQuantity * line.budgetUnitPrice),
        vendor: effectiveBudgetVendor(line, workTypeVendors),
      } : {}),
    }));
  const totalAmount = includeAmounts ? activeLines.reduce((sum, line) => sum + Math.round(line.budgetQuantity * line.budgetUnitPrice), 0) : null;
  const batch = writeBatch(db);
  batch.set(doc(db, "projects", project.procNovaProjectId, "sharedBudget", "current"), {
    projectId: project.procNovaProjectId,
    projectName: project.name,
    includeAmounts,
    workTypeOrder: orderedWorkTypes,
    rows,
    totalAmount,
    sharedBy: member.uid,
    sharedByName: member.displayName,
    sharedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, "procmanaProjects", project.id, "activityLogs")), { action: "budget.shared", actorUid: member.uid, actorName: member.displayName, after: { includeAmounts, lineCount: rows.length }, createdAt: serverTimestamp() });
  await batch.commit();
  return rows.length;
}

function orderedActiveWorkTypes(lines: ExecutionBudgetLine[], preferredOrder: string[]): string[] {
  const existing = [...new Set(lines.map((line) => line.workType.trim()).filter(Boolean))];
  return [...preferredOrder.filter((workType) => existing.includes(workType)), ...existing.filter((workType) => !preferredOrder.includes(workType))];
}

export async function savePurchaseOrderDraft(member: CompanyMembership, project: Project, order: PurchaseOrder, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("発注書を更新する権限がありません。");
  if (order.status !== "draft" || !order.active) throw new Error("確定済みの発注書は変更できません。");
  const lines = order.lines.map((line) => ({ ...line, amount: Math.round(line.quantity * line.unitPrice) }));
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const taxRate = Number.isFinite(order.taxRate) ? Math.min(100, Math.max(0, order.taxRate)) : 10;
  const tax = Math.round(subtotal * taxRate / 100);
  const now = new Date().toISOString();
  if (demo) {
    const drafts = readDemoPurchaseOrderDrafts();
    drafts[project.id] = (drafts[project.id] ?? []).map((item) => item.id === order.id ? { ...item, ...order, lines, subtotal, taxRate, tax, total: subtotal + tax, updatedAt: now } : item);
    window.localStorage.setItem(DEMO_PURCHASE_ORDER_DRAFTS_KEY, JSON.stringify(drafts));
    return;
  }
  const draftRef = doc(db, "procmanaProjects", project.id, "purchaseOrderDrafts", order.id);
  const snapshot = await getDoc(draftRef);
  if (!snapshot.exists() || snapshot.data().active === false) throw new Error("この発注書下書きは既に確定または無効化されています。");
  const batch = writeBatch(db);
  batch.update(draftRef, {
    orderDate: order.orderDate,
    deliveryStartDate: order.deliveryStartDate,
    deliveryEndDate: order.deliveryEndDate,
    siteAddress: order.siteAddress.trim(),
    paymentTerms: order.paymentTerms.trim(),
    notes: order.notes.trim(),
    taxRate,
    subtotal,
    tax,
    total: subtotal + tax,
    lines,
    updatedBy: member.uid,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function confirmPurchaseOrder(member: CompanyMembership, project: Project, draftId: string, demo: boolean): Promise<string> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("発注書を確定する権限がありません。");
  const today = new Date().toISOString().slice(0, 10);
  if (demo) {
    const drafts = readDemoPurchaseOrderDrafts();
    const current = (drafts[project.id] ?? []).find((order) => order.id === draftId && order.active);
    if (!current) throw new Error("発注書下書きが見つかりません。");
    const finalId = `order-${crypto.randomUUID()}`;
    const orderNumber = `PO-${today.replaceAll("-", "")}-${finalId.slice(-6).toUpperCase()}`;
    const confirmedAt = new Date().toISOString();
    const orders = readDemoPurchaseOrders();
    orders[project.id] = [{ ...current, id: finalId, orderNumber, status: "confirmed", active: true, confirmedAt, confirmedBy: member.uid, createdAt: confirmedAt, updatedAt: confirmedAt }, ...(orders[project.id] ?? [])];
    drafts[project.id] = (drafts[project.id] ?? []).map((order) => order.id === draftId ? { ...order, active: false, lastConfirmedSignature: current.sourceBudgetSignature, lastConfirmedOrderId: finalId, updatedAt: confirmedAt } : order);
    window.localStorage.setItem(DEMO_PURCHASE_ORDERS_KEY, JSON.stringify(orders));
    window.localStorage.setItem(DEMO_PURCHASE_ORDER_DRAFTS_KEY, JSON.stringify(drafts));
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id && ["contracted", "budgeting"].includes(item.status) ? { ...item, status: "ordering" as const, updatedAt: confirmedAt } : item)));
    return finalId;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const draftRef = doc(projectRef, "purchaseOrderDrafts", draftId);
  const snapshot = await getDoc(draftRef);
  if (!snapshot.exists() || snapshot.data().active === false) throw new Error("発注書下書きが見つからないか、既に確定されています。");
  const draft = mapPurchaseOrder(snapshot.id, project.id, snapshot.data());
  if (draft.lines.length > 450) throw new Error("1つの発注書に含められる明細は450行までです。発注先を分けてください。");
  const orderRef = doc(collection(projectRef, "purchaseOrders"));
  const orderNumber = `PO-${today.replaceAll("-", "")}-${orderRef.id.slice(-6).toUpperCase()}`;
  const batch = writeBatch(db);
  batch.set(orderRef, {
    projectId: project.id,
    companyId: project.companyId,
    ownerUid: project.ownerUid,
    vendorKey: draft.vendorKey,
    vendorName: draft.vendorName,
    orderNumber,
    status: "confirmed",
    orderDate: draft.orderDate || today,
    deliveryStartDate: draft.deliveryStartDate,
    deliveryEndDate: draft.deliveryEndDate,
    siteAddress: draft.siteAddress || project.siteAddress,
    paymentTerms: draft.paymentTerms,
    notes: draft.notes,
    subtotal: draft.subtotal,
    taxRate: draft.taxRate,
    tax: draft.tax,
    total: draft.total,
    lines: draft.lines,
    sourceBudgetSignature: draft.sourceBudgetSignature,
    revisionOfOrderId: draft.lastConfirmedOrderId,
    lastConfirmedSignature: null,
    lastConfirmedOrderId: null,
    version: draft.version,
    active: true,
    confirmedAt: serverTimestamp(),
    confirmedBy: member.uid,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.update(draftRef, {
    active: false,
    lastConfirmedSignature: draft.sourceBudgetSignature,
    lastConfirmedOrderId: orderRef.id,
    updatedAt: serverTimestamp(),
  });
  draft.lines.forEach((line) => {
    if (line.budgetLineId) batch.set(doc(projectRef, "budgets", line.budgetLineId), { orderedAmount: line.amount, updatedAt: serverTimestamp() }, { merge: true });
  });
  if (["contracted", "budgeting"].includes(project.status)) batch.update(projectRef, { status: "ordering", updatedAt: serverTimestamp() });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: "purchase_order.confirmed", actorUid: member.uid, actorName: member.displayName, targetId: orderRef.id, after: { orderNumber, vendorName: draft.vendorName, total: draft.total }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
  return orderRef.id;
}

export async function unconfirmPurchaseOrder(member: CompanyMembership, project: Project, orderId: string, demo: boolean): Promise<string> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("発注確定を解除する権限がありません。");
  const now = new Date().toISOString();
  if (demo) {
    const orders = readDemoPurchaseOrders();
    const current = (orders[project.id] ?? []).find((order) => order.id === orderId && order.status === "confirmed");
    if (!current) throw new Error("確定済みの発注書が見つかりません。");
    const draftId = purchaseOrderDraftId(current.vendorKey);
    orders[project.id] = (orders[project.id] ?? []).map((order) => order.id === orderId ? { ...order, status: "cancelled" as const, active: false, cancelledAt: now, cancellationReason: "unconfirmed_by_user", updatedAt: now } : order);
    const drafts = readDemoPurchaseOrderDrafts();
    const existingDraft = (drafts[project.id] ?? []).find((order) => order.id === draftId);
    if (existingDraft) {
      drafts[project.id] = (drafts[project.id] ?? []).map((order) => order.id === draftId ? { ...order, status: "draft" as const, active: true, revisionOfOrderId: current.revisionOfOrderId, lastConfirmedSignature: null, lastConfirmedOrderId: current.revisionOfOrderId, confirmedAt: null, confirmedBy: null, cancelledAt: null, cancellationReason: null, updatedAt: now } : order);
    } else {
      drafts[project.id] = [{ ...current, id: draftId, orderNumber: "", status: "draft" as const, active: true, revisionOfOrderId: current.revisionOfOrderId, lastConfirmedSignature: null, lastConfirmedOrderId: current.revisionOfOrderId, version: current.version + 1, confirmedAt: null, confirmedBy: null, cancelledAt: null, cancellationReason: null, createdAt: now, updatedAt: now }, ...(drafts[project.id] ?? [])];
    }
    window.localStorage.setItem(DEMO_PURCHASE_ORDERS_KEY, JSON.stringify(orders));
    window.localStorage.setItem(DEMO_PURCHASE_ORDER_DRAFTS_KEY, JSON.stringify(drafts));
    return draftId;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const orderRef = doc(projectRef, "purchaseOrders", orderId);
  const snapshot = await getDoc(orderRef);
  if (!snapshot.exists()) throw new Error("確定済みの発注書が見つかりません。");
  const order = mapPurchaseOrder(snapshot.id, project.id, snapshot.data());
  if (order.status !== "confirmed") throw new Error("この発注書は確定済みではないため解除できません。");
  const draftId = purchaseOrderDraftId(order.vendorKey);
  const draftRef = doc(projectRef, "purchaseOrderDrafts", draftId);
  const draftSnapshot = await getDoc(draftRef);
  const previousAmounts = new Map<string, number>();
  if (order.revisionOfOrderId) {
    const previousSnapshot = await getDoc(doc(projectRef, "purchaseOrders", order.revisionOfOrderId));
    if (previousSnapshot.exists()) {
      mapPurchaseOrder(previousSnapshot.id, project.id, previousSnapshot.data()).lines.forEach((line) => {
        if (line.budgetLineId) previousAmounts.set(line.budgetLineId, line.amount);
      });
    }
  }
  const batch = writeBatch(db);
  batch.update(orderRef, { status: "cancelled", active: false, cancelledAt: serverTimestamp(), cancellationReason: "unconfirmed_by_user", updatedAt: serverTimestamp() });
  if (draftSnapshot.exists()) {
    batch.update(draftRef, { status: "draft", active: true, revisionOfOrderId: order.revisionOfOrderId, lastConfirmedSignature: null, lastConfirmedOrderId: order.revisionOfOrderId, confirmedAt: null, confirmedBy: null, cancelledAt: null, cancellationReason: null, updatedAt: serverTimestamp() });
  } else {
    batch.set(draftRef, {
      projectId: project.id, companyId: order.companyId, ownerUid: order.ownerUid,
      vendorKey: order.vendorKey, vendorName: order.vendorName, orderNumber: "", status: "draft",
      orderDate: order.orderDate, deliveryStartDate: order.deliveryStartDate, deliveryEndDate: order.deliveryEndDate,
      siteAddress: order.siteAddress, paymentTerms: order.paymentTerms, notes: order.notes,
      subtotal: order.subtotal, taxRate: order.taxRate, tax: order.tax, total: order.total, lines: order.lines,
      sourceBudgetSignature: order.sourceBudgetSignature, revisionOfOrderId: order.revisionOfOrderId,
      lastConfirmedSignature: null, lastConfirmedOrderId: order.revisionOfOrderId, version: order.version + 1,
      active: true, confirmedAt: null, confirmedBy: null, cancelledAt: null, cancellationReason: null,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  }
  order.lines.forEach((line) => {
    if (line.budgetLineId) batch.set(doc(projectRef, "budgets", line.budgetLineId), { orderedAmount: previousAmounts.get(line.budgetLineId) ?? 0, updatedAt: serverTimestamp() }, { merge: true });
  });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: "purchase_order.unconfirmed", actorUid: member.uid, actorName: member.displayName, targetId: orderId, after: { orderNumber: order.orderNumber, vendorName: order.vendorName, total: order.total }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
  return draftId;
}

export async function saveEstimate(member: CompanyMembership, project: Project, header: EstimateHeaderInput, lines: EstimateLine[], costRates: { defaultCostRate: number; workTypeCostRates: Record<string, number> }, demo: boolean, estimateId?: string, options: { autoSave?: boolean; create?: boolean; updateFinancials?: boolean } = {}): Promise<string> {
  const targetId = estimateId ?? `estimate-${crypto.randomUUID()}`;
  const isCreate = !estimateId || options.create === true;
  const totals = estimateTotals(lines, header.discount, header.taxRate);
  const now = new Date().toISOString();
  const estimate: Estimate = { id: targetId, companyId: project.ownerUid, projectId: project.id, ...header, ...costRates, lines, ...totals, status: "draft", version: 1, createdAt: now, updatedAt: now };
  if (demo) {
    const all = readDemoEstimates(); const previous = all[project.id] ?? [];
    all[project.id] = [estimate, ...previous.filter((item) => item.id !== targetId)];
    window.localStorage.setItem(DEMO_ESTIMATES_KEY, JSON.stringify(all));
    if (options.updateFinancials !== false) window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, estimateAmount: totals.total, updatedAt: now } : item)));
    return targetId;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  const firestoreLines = lines.map((line) => {
    if (line.conversionRate !== undefined) return line;
    const inheritedLine = { ...line };
    delete inheritedLine.conversionRate;
    return inheritedLine;
  });
  const firestoreEstimate: Partial<Estimate> = { ...estimate };
  delete firestoreEstimate.createdAt;
  delete firestoreEstimate.updatedAt;
  batch.set(doc(projectRef, "estimates", targetId), { ...firestoreEstimate, lines: firestoreLines, ownerUid: project.ownerUid, ...(isCreate ? { createdAt: serverTimestamp() } : {}), updatedAt: serverTimestamp() }, { merge: true });
  if (options.updateFinancials !== false) batch.set(doc(projectRef, "private", "financials"), { estimateAmount: totals.total, updatedAt: serverTimestamp() }, { merge: true });
  if (!options.autoSave) batch.set(doc(collection(projectRef, "activityLogs")), { action: isCreate ? "estimate.created" : "estimate.updated", actorUid: member.uid, actorName: member.displayName, targetId, after: { total: totals.total }, createdAt: serverTimestamp() });
  await batch.commit();
  if (!options.autoSave) invalidateProjectListCache(member.uid);
  return targetId;
}

export async function confirmContract(member: CompanyMembership, project: Project, estimate: Estimate, input: ContractInput, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("契約を確定する権限がありません。");
  if (project.procNovaLinkStatus !== "linked" && project.ownerUid !== member.uid) throw new Error("初回のProcNova連携は工事ownerが実行してください。");
  const link = demo ? { procNovaProjectId: project.id, procNovaProjectUrl: `/proclink/projects/${project.id}`, siteShareCode: "DEMO01", linkedAt: new Date().toISOString(), status: "linked" as const } : await procNovaService.createProject({ procManaProjectId: project.id, projectName: project.name, siteAddress: project.siteAddress, startDate: input.startDate, plannedEndDate: input.plannedEndDate, supervisorName: project.managerName, customerName: project.customerName }, member);
  const plannedCost = estimate.lines.reduce((sum, line) => sum + line.costAmount, 0);
  const reactivating = project.contractState === "cancelled";
  const retainedPlannedCost = reactivating ? project.plannedCost : plannedCost;
  const initialBudgetWorkTypeOrder = [...new Set(estimate.lines.filter((line) => line.parentId !== null && line.lineType === "detail").map((line) => line.workType.trim()).filter(Boolean))];
  if (demo) {
    const confirmedAt = new Date().toISOString();
    const contractId = project.lastContractId ?? project.activeContractId ?? `demo-contract-${crypto.randomUUID()}`;
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, status: "contracted" as const, contractState: "active" as const, activeContractId: contractId, lastContractId: contractId, contractConfirmedAt: confirmedAt, contractAmount: input.amount, plannedCost: retainedPlannedCost, plannedStartDate: input.startDate, plannedEndDate: input.plannedEndDate, procNovaProjectId: link.procNovaProjectId, procNovaProjectUrl: link.procNovaProjectUrl, procNovaLinkStatus: "linked" as const, siteShareCode: link.siteShareCode, updatedAt: confirmedAt } : item)));
    return;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  let reusableContractId = reactivating ? project.lastContractId : null;
  if (reactivating && !reusableContractId) {
    const contracts = await getDocs(collection(projectRef, "contracts"));
    const latestCancelled = contracts.docs
      .filter((snapshot) => snapshot.data().status === "cancelled" || snapshot.data().active === false)
      .sort((a, b) => Date.parse(nullableIso(b.data().cancelledAt) ?? iso(b.data().confirmedAt)) - Date.parse(nullableIso(a.data().cancelledAt) ?? iso(a.data().confirmedAt)))[0];
    reusableContractId = latestCancelled?.id ?? null;
  }
  const contractRef = reusableContractId ? doc(projectRef, "contracts", reusableContractId) : doc(collection(projectRef, "contracts"));
  const batch = writeBatch(db);
  if (reactivating && reusableContractId) {
    batch.set(contractRef, { ...input, status: "active", active: true, reactivatedAt: serverTimestamp(), reactivatedBy: member.uid, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    batch.set(contractRef, { ...input, id: contractRef.id, ownerUid: project.ownerUid, projectId: project.id, version: 1, status: "active", active: true, confirmedAt: serverTimestamp(), confirmedBy: member.uid });
  }
  batch.update(doc(projectRef, "estimates", estimate.id), { status: "adopted", adoptedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.update(projectRef, { status: "contracted", contractState: "active", activeContractId: contractRef.id, lastContractId: contractRef.id, contractConfirmedAt: serverTimestamp(), plannedStartDate: input.startDate, plannedEndDate: input.plannedEndDate, procNovaProjectId: link.procNovaProjectId, procNovaProjectUrl: link.procNovaProjectUrl, procNovaLinkStatus: "linked", siteShareCode: link.siteShareCode || null, procNovaLinkedAt: Timestamp.fromDate(new Date(link.linkedAt)), ...(!reactivating ? { budgetWorkTypeOrder: initialBudgetWorkTypeOrder } : {}), updatedAt: serverTimestamp() });
  batch.set(doc(projectRef, "private", "financials"), { contractAmount: input.amount, plannedCost: retainedPlannedCost, updatedAt: serverTimestamp() }, { merge: true });
  if (!reactivating) estimate.lines.filter((line) => line.parentId !== null && line.lineType === "detail" && line.itemName.trim() !== "").forEach((line) => batch.set(doc(projectRef, "budgets", line.id), {
    ownerUid: project.ownerUid,
    projectId: project.id,
    sourceEstimateId: estimate.id,
    estimateLineId: line.id,
    workType: line.workType,
    itemName: line.itemName,
    specification: line.specification,
    specNumber: line.specNumber,
    unit: line.unit,
    estimateQuantity: line.quantity,
    estimateCostUnitPrice: line.costUnitPrice,
    estimateCost: line.costAmount,
    budgetQuantity: line.quantity,
    budgetUnitPrice: line.costUnitPrice,
    budgetCost: line.costAmount,
    plannedVendor: "",
    orderedAmount: 0,
    actualCost: 0,
    variance: line.costAmount,
    notes: line.notes,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  batch.set(doc(collection(projectRef, "activityLogs")), { action: reactivating ? "contract.reactivated" : "contract.confirmed", actorUid: member.uid, actorName: member.displayName, targetId: contractRef.id, before: { status: project.status, contractState: project.contractState }, after: { status: "contracted", contractState: "active", contractAmount: input.amount, procNovaProjectId: link.procNovaProjectId, reusedContractDocument: Boolean(reusableContractId) }, createdAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
}

export async function cancelContract(member: CompanyMembership, project: Project, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("契約を解除する権限がありません。");
  if (project.managementRole === "admin" && project.procNovaLinkStatus !== "linked") throw new Error("初回のProcNova連携前は工事ownerだけが契約を操作できます。");
  if (project.contractState !== "active") throw new Error("現在有効な契約がありません。");

  const cancelledAt = new Date().toISOString();
  if (demo) {
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? {
      ...item,
      status: "contract_cancelled" as const,
      contractState: "cancelled" as const,
      activeContractId: null,
      lastContractId: item.activeContractId ?? item.lastContractId,
      contractCancelledAt: cancelledAt,
      contractCancelledBy: member.uid,
      updatedAt: cancelledAt,
    } : item)));
    return;
  }

  const projectRef = doc(db, "procmanaProjects", project.id);
  let activeContractId = project.activeContractId;
  if (!activeContractId) {
    const contracts = await getDocs(collection(projectRef, "contracts"));
    const latestActive = contracts.docs
      .filter((snapshot) => snapshot.data().status !== "cancelled" && snapshot.data().active !== false)
      .sort((a, b) => Date.parse(iso(b.data().confirmedAt)) - Date.parse(iso(a.data().confirmedAt)))[0];
    activeContractId = latestActive?.id ?? null;
  }

  const batch = writeBatch(db);
  batch.update(projectRef, {
    status: "contract_cancelled",
    contractState: "cancelled",
    activeContractId: null,
    lastContractId: activeContractId,
    contractCancelledAt: serverTimestamp(),
    contractCancelledBy: member.uid,
    updatedAt: serverTimestamp(),
  });
  if (activeContractId) {
    batch.set(doc(projectRef, "contracts", activeContractId), {
      status: "cancelled",
      active: false,
      cancelledAt: serverTimestamp(),
      cancelledBy: member.uid,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }
  batch.set(doc(collection(projectRef, "activityLogs")), {
    action: "contract.cancelled",
    actorUid: member.uid,
    actorName: member.displayName,
    targetId: activeContractId,
    before: { status: project.status, contractState: project.contractState },
    after: { status: "contract_cancelled", contractState: "cancelled", dataRetained: true },
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  invalidateProjectListCache(member.uid);
}

const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function inviteCode(): string {
  const values = crypto.getRandomValues(new Uint32Array(8));
  return Array.from(values, (value) => INVITE_ALPHABET[value % INVITE_ALPHABET.length]).join("");
}

export async function listProjectMembers(projectId: string, demo: boolean): Promise<ProjectMember[]> {
  if (demo) return [{ uid: demoMembership.uid, displayName: demoMembership.displayName, email: demoMembership.email, siteRole: "owner", managementRole: "owner", joinedBy: "owner", active: true }];
  const snapshots = await getDocs(collection(db, "procmanaProjects", projectId, "members"));
  return snapshots.docs.map((snapshot) => { const data = snapshot.data(); return { uid: snapshot.id, displayName: text(data.displayName), email: text(data.email), siteRole: siteRole(data.siteRole), managementRole: managementRole(data.managementRole), joinedBy: data.joinedBy === "management_invite" ? "management_invite" : "owner", active: data.active !== false }; });
}

export async function createManagementInvite(member: CompanyMembership, project: Project, role: "admin" | "accounting", demo: boolean): Promise<ManagementInvite> {
  if (project.ownerUid !== member.uid) throw new Error("ownerだけが経営管理権限を招待できます。");
  const code = inviteCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (!demo) await runTransaction(db, async (transaction) => {
    const ref = doc(db, "procManaInviteCodes", code);
    if ((await transaction.get(ref)).exists()) throw new Error("招待コードが重複しました。再実行してください。");
    transaction.set(ref, { code, projectId: project.id, projectName: project.name, ownerUid: member.uid, managementRole: role, active: true, maxUses: 1, usedBy: null, expiresAt: Timestamp.fromDate(expiresAt), createdAt: serverTimestamp() });
  });
  return { code, projectId: project.id, projectName: project.name, role, expiresAt: expiresAt.toISOString() };
}

export async function redeemManagementInvite(member: CompanyMembership, rawCode: string, demo: boolean): Promise<string> {
  const code = rawCode.replace(/\s+/g, "").toUpperCase();
  if (demo) return demoProjects[0]?.id ?? "";
  const inviteRef = doc(db, "procManaInviteCodes", code);
  return runTransaction(db, async (transaction) => {
    const inviteSnap = await transaction.get(inviteRef);
    if (!inviteSnap.exists()) throw new Error("招待コードが見つかりません。");
    const invite = inviteSnap.data();
    if (invite.active !== true || invite.usedBy) throw new Error("この招待コードは使用済みです。");
    if (!(invite.expiresAt instanceof Timestamp) || invite.expiresAt.toMillis() < Date.now()) throw new Error("招待コードの有効期限が切れています。");
    const projectId = text(invite.projectId);
    const projectSnap = await transaction.get(doc(db, "procmanaProjects", projectId));
    if (!projectSnap.exists() || projectSnap.data().ownerUid !== invite.ownerUid) throw new Error("対象工事を確認できません。");
    const role = invite.managementRole === "accounting" ? "accounting" : "admin";
    const access = { uid: member.uid, projectId, projectName: text(invite.projectName), ownerUid: text(invite.ownerUid), siteRole: "none", managementRole: role, inviteCode: code, source: "management_invite", active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    transaction.set(doc(db, "users", member.uid, "procManaProjects", projectId), access);
    transaction.set(doc(db, "procmanaProjects", projectId, "members", member.uid), { ...access, displayName: member.displayName, email: member.email, joinedBy: "management_invite" });
    transaction.update(inviteRef, { active: false, usedBy: member.uid, usedAt: serverTimestamp() });
    return projectId;
  });
}

export async function updateManagementRole(actor: CompanyMembership, project: Project, target: ProjectMember, role: "admin" | "accounting" | "none", demo: boolean): Promise<void> {
  if (project.ownerUid !== actor.uid || target.managementRole === "owner") throw new Error("権限を変更できません。");
  if (demo) return;
  const batch = writeBatch(db);
  batch.update(doc(db, "procmanaProjects", project.id, "members", target.uid), { managementRole: role, active: role !== "none", updatedAt: serverTimestamp() });
  batch.set(doc(db, "users", target.uid, "procManaProjects", project.id), { uid: target.uid, projectId: project.id, projectName: project.name, ownerUid: project.ownerUid, siteRole: target.siteRole, managementRole: role, active: role !== "none", updatedAt: serverTimestamp() }, { merge: true });
  batch.set(doc(collection(db, "procmanaProjects", project.id, "activityLogs")), { action: "management.permission_changed", actorUid: actor.uid, actorName: actor.displayName, targetId: target.uid, before: { managementRole: target.managementRole }, after: { managementRole: role }, createdAt: serverTimestamp() });
  await batch.commit();
}

// ─────────────────────────────────────────────
// 請求（出来高部分払い）
// ─────────────────────────────────────────────
const DEMO_INVOICES_KEY = "procmana.demo.invoices.v1";

function readDemoInvoices(): Record<string, Invoice[]> {
  const saved = window.localStorage.getItem(DEMO_INVOICES_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, Invoice[]>; } catch { return {}; }
}

function mapInvoiceLine(raw: unknown, index: number): InvoiceLine {
  const item = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  return {
    id: text(item.id) || `invoice-line-${index}`,
    name: text(item.name),
    contractQuantity: number(item.contractQuantity),
    contractUnit: text(item.contractUnit),
    contractAmount: number(item.contractAmount),
    previousAmount: number(item.previousAmount),
    currentAmount: number(item.currentAmount),
  };
}

function mapInvoice(id: string, projectId: string, data: DocumentData): Invoice {
  const subtotal = number(data.subtotal);
  const taxRate = Number.isFinite(data.taxRate) ? Number(data.taxRate) : 10;
  const tax = number(data.tax);
  return {
    id,
    projectId,
    invoiceNumber: text(data.invoiceNumber),
    title: text(data.title),
    billingDate: text(data.billingDate),
    periodStart: text(data.periodStart),
    periodEnd: text(data.periodEnd),
    subtotal,
    taxRate,
    tax,
    total: number(data.total) || subtotal + tax,
    paymentDueDate: text(data.paymentDueDate),
    notes: text(data.notes),
    billingType: data.billingType === "milestone" ? "milestone" : "monthly",
    milestoneId: nullableText(data.milestoneId),
    lines: Array.isArray(data.lines) ? data.lines.map(mapInvoiceLine) : [],
    status: data.status === "issued" ? "issued" : "draft",
    issuedAt: nullableIso(data.issuedAt),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

export async function listInvoices(projectId: string, demo: boolean): Promise<Invoice[]> {
  if (demo) return (readDemoInvoices()[projectId] ?? []).slice().sort((a, b) => b.billingDate.localeCompare(a.billingDate) || b.createdAt.localeCompare(a.createdAt));
  const snapshots = await getDocs(collection(db, "procmanaProjects", projectId, "invoices"));
  return snapshots.docs
    .map((snapshot) => mapInvoice(snapshot.id, projectId, snapshot.data()))
    .sort((a, b) => b.billingDate.localeCompare(a.billingDate) || b.createdAt.localeCompare(a.createdAt));
}

function invoicedTotalOf(invoices: Invoice[]): number {
  return invoices.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + invoice.total, 0);
}

const DEMO_INVOICE_SETTINGS_KEY = "procmana.demo.invoiceSettings.v1";

function readDemoInvoiceSettings(): Record<string, InvoiceSettings> {
  const saved = window.localStorage.getItem(DEMO_INVOICE_SETTINGS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, InvoiceSettings>; } catch { return {}; }
}

function mapInvoiceSettings(data: DocumentData): InvoiceSettings {
  const milestones = Array.isArray(data.invoiceMilestones)
    ? data.invoiceMilestones.map((raw: unknown, index: number): InvoiceMilestone => {
        const item = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
        return { id: text(item.id) || `ms-${index}`, name: text(item.name), percent: number(item.percent) };
      })
    : [];
  const rawBilling = typeof data.invoiceWorkTypeBilling === "object" && data.invoiceWorkTypeBilling !== null ? data.invoiceWorkTypeBilling as Record<string, unknown> : {};
  const workTypeBilling: Record<string, WorkTypeBilling> = Object.fromEntries(Object.entries(rawBilling).map(([workType, raw]) => {
    const item = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const rule = item.rule === "schedule" || item.rule === "startEnd" || item.rule === "manual" ? item.rule : "progress";
    return [workType, { rule, percent: Math.min(100, Math.max(0, number(item.percent))) }] as const;
  }));
  return {
    billingType: data.invoiceBillingType === "milestone" ? "milestone" : "monthly",
    closingDay: Number.isFinite(data.invoiceClosingDay) ? Math.min(28, Math.max(0, Number(data.invoiceClosingDay))) : 0,
    milestones,
    workTypeBilling,
    registrationNumber: text(data.invoiceRegistrationNumber),
    fax: text(data.invoiceFax),
    bankName: text(data.invoiceBankName),
    branchName: text(data.invoiceBranchName),
    accountType: text(data.invoiceAccountType) || "普通",
    accountNumber: text(data.invoiceAccountNumber),
    accountHolder: text(data.invoiceAccountHolder),
  };
}

export async function loadInvoiceSettings(projectId: string, demo: boolean): Promise<InvoiceSettings> {
  if (demo) return readDemoInvoiceSettings()[projectId] ?? { billingType: "monthly", closingDay: 0, milestones: [], workTypeBilling: {}, registrationNumber: "", fax: "", bankName: "", branchName: "", accountType: "普通", accountNumber: "", accountHolder: "" };
  const snapshot = await getDoc(doc(db, "procmanaProjects", projectId, "private", "financials"));
  return mapInvoiceSettings(snapshot.exists() ? snapshot.data() : {});
}

export async function saveInvoiceSettings(member: CompanyMembership, project: Project, settings: InvoiceSettings, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("請求設定を更新する権限がありません。");
  const milestones = settings.milestones
    .map((item, index) => ({ id: item.id || `ms-${index}`, name: item.name.trim(), percent: Math.max(0, Math.round((Number.isFinite(item.percent) ? item.percent : 0) * 10) / 10) }))
    .filter((item) => item.name !== "" || item.percent > 0);
  const closingDay = Number.isFinite(settings.closingDay) ? Math.min(28, Math.max(0, Math.round(settings.closingDay))) : 0;
  const payload = {
    invoiceBillingType: settings.billingType === "milestone" ? "milestone" : "monthly",
    invoiceClosingDay: closingDay,
    invoiceMilestones: milestones,
    invoiceWorkTypeBilling: Object.fromEntries(Object.entries(settings.workTypeBilling ?? {}).map(([workType, item]) => [workType.trim(), { rule: item.rule, percent: Math.min(100, Math.max(0, Number.isFinite(item.percent) ? Math.round(item.percent * 10) / 10 : 0)) }] as const).filter(([workType]) => workType !== "")),
    invoiceRegistrationNumber: settings.registrationNumber.trim(),
    invoiceFax: settings.fax.trim(),
    invoiceBankName: settings.bankName.trim(),
    invoiceBranchName: settings.branchName.trim(),
    invoiceAccountType: settings.accountType.trim() || "普通",
    invoiceAccountNumber: settings.accountNumber.trim(),
    invoiceAccountHolder: settings.accountHolder.trim(),
  };
  if (demo) {
    const all = readDemoInvoiceSettings();
    all[project.id] = { ...settings, billingType: payload.invoiceBillingType as BillingType, closingDay, milestones };
    window.localStorage.setItem(DEMO_INVOICE_SETTINGS_KEY, JSON.stringify(all));
    return;
  }
  await setDoc(doc(db, "procmanaProjects", project.id, "private", "financials"), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveInvoice(member: CompanyMembership, project: Project, invoice: Invoice, demo: boolean): Promise<string> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("請求書を編集する権限がありません。");
  const subtotal = Math.max(0, Math.round(invoice.subtotal));
  const taxRate = Number.isFinite(invoice.taxRate) ? Math.min(100, Math.max(0, invoice.taxRate)) : 10;
  const tax = Math.round(subtotal * taxRate / 100);
  const total = subtotal + tax;
  const now = new Date().toISOString();
  const id = invoice.id || `invoice-${crypto.randomUUID()}`;
  const normalized: Invoice = { ...invoice, id, projectId: project.id, subtotal, taxRate, tax, total, updatedAt: now };
  if (demo) {
    const all = readDemoInvoices();
    const list = all[project.id] ?? [];
    const exists = list.some((item) => item.id === id);
    all[project.id] = exists ? list.map((item) => item.id === id ? normalized : item) : [{ ...normalized, createdAt: now }, ...list];
    window.localStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(all));
    const invoiced = invoicedTotalOf(all[project.id]);
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, invoicedAmount: invoiced, billingProgress: item.contractAmount > 0 ? Math.round(invoiced / item.contractAmount * 1000) / 10 : 0, updatedAt: now } : item)));
    return id;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  const invoiceRef = doc(projectRef, "invoices", id);
  const existing = await getDoc(invoiceRef);
  const batch = writeBatch(db);
  batch.set(invoiceRef, {
    projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
    invoiceNumber: normalized.invoiceNumber, title: normalized.title.trim(),
    billingDate: normalized.billingDate, periodStart: normalized.periodStart, periodEnd: normalized.periodEnd,
    subtotal, taxRate, tax, total, paymentDueDate: normalized.paymentDueDate, notes: normalized.notes.trim(),
    billingType: normalized.billingType === "milestone" ? "milestone" : "monthly", milestoneId: normalized.milestoneId ?? null,
    lines: normalized.lines.map((line) => ({ ...line, contractAmount: Math.round(line.contractAmount), previousAmount: Math.round(line.previousAmount), currentAmount: Math.round(line.currentAmount) })),
    status: normalized.status, issuedAt: normalized.issuedAt ?? null,
    updatedBy: member.uid, updatedAt: serverTimestamp(),
    ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
  }, { merge: true });
  await batch.commit();
  await recomputeInvoiceSummary(member, project);
  return id;
}

export async function setInvoiceStatus(member: CompanyMembership, project: Project, invoiceId: string, status: InvoiceStatus, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("請求書を更新する権限がありません。");
  const now = new Date().toISOString();
  if (demo) {
    const all = readDemoInvoices();
    all[project.id] = (all[project.id] ?? []).map((item) => item.id === invoiceId ? { ...item, status, issuedAt: status === "issued" ? (item.issuedAt ?? now) : null, updatedAt: now } : item);
    window.localStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(all));
    const invoiced = invoicedTotalOf(all[project.id]);
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, invoicedAmount: invoiced, billingProgress: item.contractAmount > 0 ? Math.round(invoiced / item.contractAmount * 1000) / 10 : 0, updatedAt: now } : item)));
    return;
  }
  const projectRef = doc(db, "procmanaProjects", project.id);
  await setDoc(doc(projectRef, "invoices", invoiceId), { status, issuedAt: status === "issued" ? serverTimestamp() : null, updatedBy: member.uid, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(doc(collection(projectRef, "activityLogs")), { action: status === "issued" ? "invoice.issued" : "invoice.reverted", actorUid: member.uid, actorName: member.displayName, targetId: invoiceId, createdAt: serverTimestamp() });
  await recomputeInvoiceSummary(member, project);
}

export async function deleteInvoice(member: CompanyMembership, project: Project, invoiceId: string, demo: boolean): Promise<void> {
  if (project.managementRole !== "owner" && project.managementRole !== "admin") throw new Error("請求書を削除する権限がありません。");
  const now = new Date().toISOString();
  if (demo) {
    const all = readDemoInvoices();
    all[project.id] = (all[project.id] ?? []).filter((item) => item.id !== invoiceId);
    window.localStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(all));
    const invoiced = invoicedTotalOf(all[project.id]);
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, invoicedAmount: invoiced, billingProgress: item.contractAmount > 0 ? Math.round(invoiced / item.contractAmount * 1000) / 10 : 0, updatedAt: now } : item)));
    return;
  }
  await deleteDoc(doc(db, "procmanaProjects", project.id, "invoices", invoiceId));
  await recomputeInvoiceSummary(member, project);
}

async function recomputeInvoiceSummary(member: CompanyMembership, project: Project): Promise<void> {
  const projectRef = doc(db, "procmanaProjects", project.id);
  const snapshots = await getDocs(collection(projectRef, "invoices"));
  const invoiced = invoicedTotalOf(snapshots.docs.map((snapshot) => mapInvoice(snapshot.id, project.id, snapshot.data())));
  const billingProgress = project.contractAmount > 0 ? Math.round(invoiced / project.contractAmount * 1000) / 10 : 0;
  const batch = writeBatch(db);
  batch.set(doc(projectRef, "private", "financials"), { invoicedAmount: invoiced, updatedAt: serverTimestamp() }, { merge: true });
  batch.update(projectRef, { billingProgress, updatedAt: serverTimestamp() });
  await batch.commit();
  invalidateProjectListCache(member.uid);
}

// ─────────────────────────────────────────────
// 入金（発行済み請求書に対する消込）
// ─────────────────────────────────────────────
const DEMO_PAYMENTS_KEY = "procmana.demo.payments.v1";

function readDemoPayments(): Record<string, Payment[]> {
  const saved = window.localStorage.getItem(DEMO_PAYMENTS_KEY);
  if (!saved) return {};
  try { return JSON.parse(saved) as Record<string, Payment[]>; } catch { return {}; }
}

function paymentMethod(value: unknown): PaymentMethod {
  return value === "cash" || value === "check" || value === "card" || value === "other" ? value : "bank_transfer";
}

function mapPayment(id: string, projectId: string, data: DocumentData): Payment {
  return {
    id,
    projectId,
    companyId: text(data.companyId),
    ownerUid: text(data.ownerUid),
    invoiceId: text(data.invoiceId),
    invoiceNumber: text(data.invoiceNumber),
    paymentDate: text(data.paymentDate),
    amount: number(data.amount),
    method: paymentMethod(data.method),
    payerName: text(data.payerName),
    referenceNumber: text(data.referenceNumber),
    notes: text(data.notes),
    status: data.status === "cancelled" ? "cancelled" : "recorded",
    recordedBy: text(data.recordedBy),
    recordedByName: text(data.recordedByName),
    cancelledAt: nullableIso(data.cancelledAt),
    cancelledBy: nullableText(data.cancelledBy),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

export async function listPayments(projectId: string, demo: boolean): Promise<Payment[]> {
  const list = demo
    ? (readDemoPayments()[projectId] ?? [])
    : (await getDocs(collection(db, "procmanaProjects", projectId, "payments"))).docs.map((snapshot) => mapPayment(snapshot.id, projectId, snapshot.data()));
  return list.slice().sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.createdAt.localeCompare(a.createdAt));
}

function paidTotalOf(payments: Payment[]): number {
  return payments.filter((payment) => payment.status === "recorded").reduce((sum, payment) => sum + payment.amount, 0);
}

function canRecordPayment(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin" || project.managementRole === "accounting";
}

function assertPaymentAmount(invoice: Invoice, payments: Payment[], amount: number, excludePaymentId = ""): void {
  if (invoice.status !== "issued") throw new Error("発行済みの請求書だけ入金登録できます。");
  const paid = payments
    .filter((payment) => payment.status === "recorded" && payment.invoiceId === invoice.id && payment.id !== excludePaymentId)
    .reduce((sum, payment) => sum + payment.amount, 0);
  if (amount <= 0) throw new Error("入金額を入力してください。");
  if (paid + amount > invoice.total) throw new Error(`入金額が請求残高を${Math.round(paid + amount - invoice.total).toLocaleString("ja-JP")}円超えています。`);
}

export async function savePayment(member: CompanyMembership, project: Project, payment: Payment, demo: boolean): Promise<string> {
  if (!canRecordPayment(project)) throw new Error("入金を登録する権限がありません。");
  const amount = Math.max(0, Math.round(payment.amount));
  const now = new Date().toISOString();
  const id = payment.id || `payment-${crypto.randomUUID()}`;
  const invoices = await listInvoices(project.id, demo);
  const invoice = invoices.find((item) => item.id === payment.invoiceId);
  if (!invoice) throw new Error("対象の請求書が見つかりません。");
  const payments = await listPayments(project.id, demo);
  assertPaymentAmount(invoice, payments, amount, id);
  const normalized: Payment = {
    ...payment,
    id,
    projectId: project.id,
    companyId: project.companyId,
    ownerUid: project.ownerUid,
    invoiceNumber: invoice.invoiceNumber,
    amount,
    method: paymentMethod(payment.method),
    payerName: payment.payerName.trim(),
    referenceNumber: payment.referenceNumber.trim(),
    notes: payment.notes.trim(),
    status: "recorded",
    recordedBy: member.uid,
    recordedByName: member.displayName,
    cancelledAt: null,
    cancelledBy: null,
    createdAt: payment.createdAt || now,
    updatedAt: now,
  };

  if (demo) {
    const all = readDemoPayments();
    const current = all[project.id] ?? [];
    all[project.id] = current.some((item) => item.id === id)
      ? current.map((item) => item.id === id ? normalized : item)
      : [normalized, ...current];
    window.localStorage.setItem(DEMO_PAYMENTS_KEY, JSON.stringify(all));
    const paidAmount = paidTotalOf(all[project.id]);
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, paidAmount, updatedAt: now } : item)));
    return id;
  }

  const projectRef = doc(db, "procmanaProjects", project.id);
  const paymentRef = doc(projectRef, "payments", id);
  const existing = await getDoc(paymentRef);
  const batch = writeBatch(db);
  batch.set(paymentRef, {
    projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
    invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
    paymentDate: normalized.paymentDate, amount, method: normalized.method,
    payerName: normalized.payerName, referenceNumber: normalized.referenceNumber, notes: normalized.notes,
    status: "recorded", recordedBy: member.uid, recordedByName: member.displayName,
    cancelledAt: null, cancelledBy: null,
    updatedAt: serverTimestamp(),
    ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
  }, { merge: true });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: "payment.recorded", actorUid: member.uid, actorName: member.displayName, targetId: id, after: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount, paymentDate: normalized.paymentDate }, createdAt: serverTimestamp() });
  await batch.commit();
  await recomputePaymentSummary(member, project);
  return id;
}

export async function setPaymentStatus(member: CompanyMembership, project: Project, paymentId: string, status: PaymentStatus, demo: boolean): Promise<void> {
  if (!canRecordPayment(project)) throw new Error("入金を更新する権限がありません。");
  const now = new Date().toISOString();
  const payments = await listPayments(project.id, demo);
  const current = payments.find((payment) => payment.id === paymentId);
  if (!current) throw new Error("入金記録が見つかりません。");
  if (status === "recorded") {
    const invoice = (await listInvoices(project.id, demo)).find((item) => item.id === current.invoiceId);
    if (!invoice) throw new Error("対象の請求書が見つかりません。");
    assertPaymentAmount(invoice, payments, current.amount, current.id);
  }

  if (demo) {
    const all = readDemoPayments();
    all[project.id] = (all[project.id] ?? []).map((payment) => payment.id === paymentId ? {
      ...payment, status, cancelledAt: status === "cancelled" ? now : null,
      cancelledBy: status === "cancelled" ? member.uid : null, updatedAt: now,
    } : payment);
    window.localStorage.setItem(DEMO_PAYMENTS_KEY, JSON.stringify(all));
    const paidAmount = paidTotalOf(all[project.id]);
    window.localStorage.setItem(DEMO_PROJECTS_KEY, JSON.stringify(readDemoProjects().map((item) => item.id === project.id ? { ...item, paidAmount, updatedAt: now } : item)));
    return;
  }

  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  batch.set(doc(projectRef, "payments", paymentId), {
    status,
    cancelledAt: status === "cancelled" ? serverTimestamp() : null,
    cancelledBy: status === "cancelled" ? member.uid : null,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: status === "cancelled" ? "payment.cancelled" : "payment.restored", actorUid: member.uid, actorName: member.displayName, targetId: paymentId, before: { status: current.status }, after: { status }, createdAt: serverTimestamp() });
  await batch.commit();
  await recomputePaymentSummary(member, project);
}

async function recomputePaymentSummary(member: CompanyMembership, project: Project): Promise<void> {
  const projectRef = doc(db, "procmanaProjects", project.id);
  const snapshots = await getDocs(collection(projectRef, "payments"));
  const paidAmount = paidTotalOf(snapshots.docs.map((snapshot) => mapPayment(snapshot.id, project.id, snapshot.data())));
  await setDoc(doc(projectRef, "private", "financials"), { paidAmount, updatedAt: serverTimestamp() }, { merge: true });
  invalidateProjectListCache(member.uid);
}

// ─────────────────────────────────────────────
// 工事書類台帳（Firebase Storage + Firestoreメタデータ）
// ─────────────────────────────────────────────
function documentCategory(value: unknown): ProjectDocumentCategory {
  return value === "estimate" || value === "contract" || value === "order" || value === "invoice" || value === "drawing" || value === "report" || value === "permit" || value === "photo" ? value : "other";
}

function mapProjectDocument(id: string, projectId: string, data: DocumentData): ProjectDocument {
  return {
    id,
    projectId,
    companyId: text(data.companyId),
    ownerUid: text(data.ownerUid),
    name: text(data.name),
    originalName: text(data.originalName),
    category: documentCategory(data.category),
    description: text(data.description),
    storagePath: text(data.storagePath),
    fileUrl: text(data.fileUrl),
    contentType: text(data.contentType),
    size: number(data.size),
    status: data.status === "archived" ? "archived" : "active",
    uploadedBy: text(data.uploadedBy),
    uploadedByName: text(data.uploadedByName),
    archivedAt: nullableIso(data.archivedAt),
    archivedBy: nullableText(data.archivedBy),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function canManageProjectDocuments(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin" || project.managementRole === "accounting";
}

export async function listProjectDocuments(projectId: string, demo: boolean): Promise<ProjectDocument[]> {
  if (demo) return [];
  const snapshots = await getDocs(collection(db, "procmanaProjects", projectId, "documents"));
  return snapshots.docs
    .map((snapshot) => mapProjectDocument(snapshot.id, projectId, snapshot.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function safeStorageFileName(fileName: string): string {
  const normalized = fileName.normalize("NFKC").replace(/[\\/#?\[\]]/g, "_").replace(/\s+/g, "_");
  return normalized.slice(-160) || "document";
}

export async function uploadProjectDocument(
  member: CompanyMembership,
  project: Project,
  file: File,
  category: ProjectDocumentCategory,
  description: string,
  demo: boolean,
): Promise<string> {
  if (!canManageProjectDocuments(project)) throw new Error("書類を追加する権限がありません。");
  if (demo) throw new Error("デモモードではファイルをアップロードできません。");
  if (file.size <= 0) throw new Error(`${file.name}は空のファイルです。`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}は20MBを超えています。`);
  const id = `document-${crypto.randomUUID()}`;
  const fileName = safeStorageFileName(file.name);
  const path = `procmanaProjects/${project.id}/documents/${id}/${fileName}`;
  const fileRef = storageRef(storage, path);
  let uploaded = false;
  try {
    await uploadBytes(fileRef, file, {
      contentType: file.type || "application/octet-stream",
      customMetadata: { projectId: project.id, documentId: id, uploadedBy: member.uid },
    });
    uploaded = true;
    const fileUrl = await getDownloadURL(fileRef);
    const projectRef = doc(db, "procmanaProjects", project.id);
    const batch = writeBatch(db);
    batch.set(doc(projectRef, "documents", id), {
      projectId: project.id, companyId: project.companyId, ownerUid: project.ownerUid,
      name: file.name, originalName: file.name, category: documentCategory(category), description: description.trim(),
      storagePath: path, fileUrl, contentType: file.type || "application/octet-stream", size: file.size,
      status: "active", uploadedBy: member.uid, uploadedByName: member.displayName,
      archivedAt: null, archivedBy: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(collection(projectRef, "activityLogs")), { action: "document.uploaded", actorUid: member.uid, actorName: member.displayName, targetId: id, after: { name: file.name, category: documentCategory(category), size: file.size }, createdAt: serverTimestamp() });
    await batch.commit();
    return id;
  } catch (error) {
    if (uploaded) await deleteObject(fileRef).catch(() => undefined);
    throw error;
  }
}

export async function setProjectDocumentStatus(member: CompanyMembership, project: Project, documentId: string, status: ProjectDocumentStatus, demo: boolean): Promise<void> {
  if (!canManageProjectDocuments(project)) throw new Error("書類を更新する権限がありません。");
  if (demo) return;
  const projectRef = doc(db, "procmanaProjects", project.id);
  const documentRef = doc(projectRef, "documents", documentId);
  const snapshot = await getDoc(documentRef);
  if (!snapshot.exists()) throw new Error("書類が見つかりません。");
  const current = mapProjectDocument(snapshot.id, project.id, snapshot.data());
  const batch = writeBatch(db);
  batch.set(documentRef, {
    status,
    archivedAt: status === "archived" ? serverTimestamp() : null,
    archivedBy: status === "archived" ? member.uid : null,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  batch.set(doc(collection(projectRef, "activityLogs")), { action: status === "archived" ? "document.archived" : "document.restored", actorUid: member.uid, actorName: member.displayName, targetId: documentId, before: { status: current.status }, after: { status }, createdAt: serverTimestamp() });
  await batch.commit();
}

/** ProcMana専用保管庫のファイルと台帳を削除する。操作履歴だけは残す。 */
export async function deleteProjectDocument(
  member: CompanyMembership,
  project: Project,
  document: ProjectDocument,
  demo: boolean,
): Promise<void> {
  if (!canManageProjectDocuments(project)) throw new Error("書類を削除する権限がありません。");
  if (demo) return;
  if (document.projectId !== project.id) throw new Error("対象書類の工事が一致しません。");
  const projectRef = doc(db, "procmanaProjects", project.id);
  const batch = writeBatch(db);
  batch.delete(doc(projectRef, "documents", document.id));
  batch.set(doc(collection(projectRef, "activityLogs")), {
    action: "document.deleted",
    actorUid: member.uid,
    actorName: member.displayName,
    targetId: document.id,
    before: { name: document.name, category: document.category, size: document.size },
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  if (document.storagePath) await deleteObject(storageRef(storage, document.storagePath)).catch(() => undefined);
}

function mapProcNovaVaultDocument(id: string, projectId: string, data: DocumentData): ProcNovaVaultDocument {
  return {
    id,
    projectId,
    name: text(data.name),
    category: documentCategory(data.category),
    description: text(data.description),
    storagePath: text(data.storagePath),
    fileUrl: text(data.downloadUrl) || text(data.fileUrl),
    contentType: text(data.fileType) || text(data.contentType),
    size: number(data.fileSize) || number(data.size),
    uploadedBy: text(data.uploadedBy),
    uploadedByName: text(data.uploadedByName),
    folderId: nullableText(data.folderId),
    commentCount: number(data.commentCount),
    createdAt: iso(data.createdAt),
  };
}

function mapProcNovaVaultFolder(id: string, projectId: string, data: DocumentData): ProcNovaVaultFolder {
  return {
    id,
    projectId,
    name: text(data.name),
    createdBy: text(data.createdBy),
    createdByName: text(data.createdByName),
    createdAt: iso(data.createdAt),
  };
}

/** 連携済みProcNova工事の保管庫を、ファイルを複製せず直接参照する。 */
export async function listProcNovaVaultDocuments(project: Project, demo: boolean): Promise<ProcNovaVaultDocument[]> {
  if (demo || project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) return [];
  const projectId = project.procNovaProjectId;
  const snapshots = await getDocs(collection(db, "projects", projectId, "documents"));
  return snapshots.docs
    .map((snapshot) => mapProcNovaVaultDocument(snapshot.id, projectId, snapshot.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 連携済みProcNova工事の保管庫フォルダを直接参照する。 */
export async function listProcNovaVaultFolders(project: Project, demo: boolean): Promise<ProcNovaVaultFolder[]> {
  if (demo || project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) return [];
  const projectId = project.procNovaProjectId;
  const snapshots = await getDocs(collection(db, "projects", projectId, "documentsFolders"));
  return snapshots.docs
    .map((snapshot) => mapProcNovaVaultFolder(snapshot.id, projectId, snapshot.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** ProcManaからProcNova保管庫へフォルダを追加する。 */
export async function createProcNovaVaultFolder(
  member: CompanyMembership,
  project: Project,
  name: string,
  demo: boolean,
): Promise<string> {
  if (!canManageProjectDocuments(project)) throw new Error("フォルダを追加する権限がありません。");
  if (demo) throw new Error("デモモードではフォルダを作成できません。");
  if (project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) throw new Error("ProcNova未連携のため、フォルダを作成できません。");
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("フォルダ名を入力してください。");
  if (normalizedName.length > 60) throw new Error("フォルダ名は60文字以内で入力してください。");
  const folderRef = doc(collection(db, "projects", project.procNovaProjectId, "documentsFolders"));
  await setDoc(folderRef, {
    name: normalizedName,
    createdBy: member.uid,
    createdByName: member.displayName,
    createdAt: serverTimestamp(),
  });
  return folderRef.id;
}

/** ProcManaからProcNova保管庫へ直接保存する。ProcMana側にファイルの複製は作らない。 */
export async function uploadProcNovaVaultDocument(
  member: CompanyMembership,
  project: Project,
  file: File,
  category: ProjectDocumentCategory,
  description: string,
  folderId: string | null,
  demo: boolean,
): Promise<string> {
  if (!canManageProjectDocuments(project)) throw new Error("書類を追加する権限がありません。");
  if (demo) throw new Error("デモモードではファイルをアップロードできません。");
  if (project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) throw new Error("ProcNova未連携のため、保管庫へ追加できません。");
  if (file.size <= 0) throw new Error(`${file.name}は空のファイルです。`);
  const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name);
  const maxBytes = (isVideo ? 200 : 50) * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`${file.name}は${isVideo ? 200 : 50}MBを超えています。`);

  const procNovaProjectId = project.procNovaProjectId;
  const documentRef = doc(collection(db, "projects", procNovaProjectId, "documents"));
  const fileName = safeStorageFileName(file.name);
  const path = `projects/${procNovaProjectId}/documents/${Date.now()}_${documentRef.id}_${fileName}`;
  const fileRef = storageRef(storage, path);
  let uploaded = false;
  try {
    await uploadBytes(fileRef, file, {
      contentType: file.type || "application/octet-stream",
      customMetadata: {
        projectId: procNovaProjectId,
        procManaProjectId: project.id,
        documentId: documentRef.id,
        uploadedBy: member.uid,
      },
    });
    uploaded = true;
    const downloadUrl = await getDownloadURL(fileRef);
    const batch = writeBatch(db);
    batch.set(documentRef, {
      name: file.name,
      storagePath: path,
      downloadUrl,
      fileType: file.type || "application/octet-stream",
      fileSize: file.size,
      uploadedBy: member.uid,
      uploadedByName: member.displayName,
      createdAt: serverTimestamp(),
      folderId,
      source: "procmana",
      procManaProjectId: project.id,
      category: documentCategory(category),
      description: description.trim(),
    });
    batch.set(doc(collection(db, "procmanaProjects", project.id, "activityLogs")), {
      action: "document.shared_to_procnova",
      actorUid: member.uid,
      actorName: member.displayName,
      targetId: documentRef.id,
      after: { name: file.name, category: documentCategory(category), size: file.size, procNovaProjectId },
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    return documentRef.id;
  } catch (error) {
    if (uploaded) await deleteObject(fileRef).catch(() => undefined);
    throw error;
  }
}

/** ProcNova保管庫内でフォルダを移動する。 */
export async function moveProcNovaVaultDocumentToFolder(
  project: Project,
  documentId: string,
  folderId: string | null,
  demo: boolean,
): Promise<void> {
  if (demo) return;
  if (project.siteRole !== "owner" && project.siteRole !== "admin") throw new Error("ProcNova保管庫内を移動する権限がありません。");
  if (project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) throw new Error("ProcNova未連携です。");
  await setDoc(doc(db, "projects", project.procNovaProjectId, "documents", documentId), { folderId }, { merge: true });
}

/** ProcNova保管庫からファイルと台帳を削除する。 */
export async function deleteProcNovaVaultDocument(
  member: CompanyMembership,
  project: Project,
  document: ProcNovaVaultDocument,
  demo: boolean,
): Promise<void> {
  if (demo) return;
  if (project.siteRole !== "owner" && project.siteRole !== "admin") throw new Error("ProcNova保管庫の書類を削除する権限がありません。");
  if (project.procNovaLinkStatus !== "linked" || !project.procNovaProjectId) throw new Error("ProcNova未連携です。");
  const batch = writeBatch(db);
  batch.delete(doc(db, "projects", project.procNovaProjectId, "documents", document.id));
  batch.set(doc(collection(db, "procmanaProjects", project.id, "activityLogs")), {
    action: "document.deleted_from_procnova",
    actorUid: member.uid,
    actorName: member.displayName,
    targetId: document.id,
    before: { name: document.name, category: document.category, size: document.size },
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  if (document.storagePath) await deleteObject(storageRef(storage, document.storagePath)).catch(() => undefined);
}

async function storageDocumentFile(storagePath: string, fileUrl: string, name: string, contentType: string): Promise<File> {
  if (!storagePath) throw new Error("元ファイルの保存先が見つかりません。");
  let blob: Blob;
  try {
    blob = await getBlob(storageRef(storage, storagePath));
  } catch (error) {
    if (!fileUrl) throw error;
    const response = await fetch(fileUrl);
    if (!response.ok) throw error;
    blob = await response.blob();
  }
  return new File([blob], name, { type: contentType || blob.type || "application/octet-stream" });
}

/** ProcMana専用保管庫からProcNova保管庫へ移動する。保存完了後に元データを削除する。 */
export async function moveProjectDocumentToProcNova(
  member: CompanyMembership,
  project: Project,
  document: ProjectDocument,
  targetFolderId: string | null,
  demo: boolean,
): Promise<void> {
  const file = await storageDocumentFile(document.storagePath, document.fileUrl, document.name, document.contentType);
  await uploadProcNovaVaultDocument(member, project, file, document.category, document.description, targetFolderId, demo);
  await deleteProjectDocument(member, project, document, demo);
}

/** ProcNova保管庫からProcMana専用保管庫へ移動する。保存完了後に元データを削除する。 */
export async function moveProcNovaVaultDocumentToProject(
  member: CompanyMembership,
  project: Project,
  document: ProcNovaVaultDocument,
  demo: boolean,
): Promise<void> {
  if (project.siteRole !== "owner" && project.siteRole !== "admin") throw new Error("ProcNova保管庫から移動する権限がありません。");
  const file = await storageDocumentFile(document.storagePath, document.fileUrl, document.name, document.contentType);
  await uploadProjectDocument(member, project, file, document.category, document.description, demo);
  await deleteProcNovaVaultDocument(member, project, document, demo);
}

// ─────────────────────────────────────────────
// 顧客マスタ（会社単位で登録し、工事へ使い回す）
// ─────────────────────────────────────────────
const DEMO_CUSTOMERS_KEY = "procmana.demo.customers.v1";

function readDemoCustomers(): Customer[] {
  const saved = window.localStorage.getItem(DEMO_CUSTOMERS_KEY);
  if (!saved) return [];
  try { return JSON.parse(saved) as Customer[]; } catch { return []; }
}

function mapCustomer(id: string, data: DocumentData): Customer {
  return {
    id,
    ownerUid: text(data.ownerUid),
    name: text(data.name),
    postalCode: text(data.postalCode),
    address: text(data.address),
    contact: text(data.contact),
    phone: text(data.phone),
    email: text(data.email),
    registrationNumber: text(data.registrationNumber),
    notes: text(data.notes),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

export async function listCustomers(member: CompanyMembership, demo: boolean): Promise<Customer[]> {
  if (demo) return readDemoCustomers().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const snapshots = await getDocs(query(collection(db, "procmanaCustomers"), where("ownerUid", "==", member.uid)));
  return snapshots.docs.map((snapshot) => mapCustomer(snapshot.id, snapshot.data())).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function saveCustomer(member: CompanyMembership, customer: Customer, demo: boolean): Promise<string> {
  const name = customer.name.trim();
  if (!name) throw new Error("顧客名を入力してください。");
  const id = customer.id || `customer-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const normalized: Customer = {
    ...customer, id, ownerUid: member.uid, name,
    postalCode: customer.postalCode.replace(/[^0-9]/g, "").slice(0, 7),
    address: customer.address.trim(), contact: customer.contact.trim(), phone: customer.phone.trim(),
    email: customer.email.trim(), registrationNumber: customer.registrationNumber.trim(), notes: customer.notes.trim(),
    updatedAt: now,
  };
  if (demo) {
    const all = readDemoCustomers();
    const exists = all.some((item) => item.id === id);
    window.localStorage.setItem(DEMO_CUSTOMERS_KEY, JSON.stringify(exists ? all.map((item) => item.id === id ? normalized : item) : [{ ...normalized, createdAt: now }, ...all]));
    return id;
  }
  // 新規作成時はドキュメントが存在せず getDoc がルールで拒否されるため、
  // 既存判定はクライアントが持つIDで行う（新規なら createdAt を付与する）。
  const isNew = !customer.id;
  await setDoc(doc(db, "procmanaCustomers", id), {
    ownerUid: member.uid, name, postalCode: normalized.postalCode, address: normalized.address, contact: normalized.contact,
    phone: normalized.phone, email: normalized.email, registrationNumber: normalized.registrationNumber, notes: normalized.notes,
    updatedAt: serverTimestamp(),
    ...(isNew ? { createdAt: serverTimestamp() } : {}),
  }, { merge: true });
  return id;
}

export async function deleteCustomer(member: CompanyMembership, customerId: string, demo: boolean): Promise<void> {
  if (demo) {
    window.localStorage.setItem(DEMO_CUSTOMERS_KEY, JSON.stringify(readDemoCustomers().filter((item) => item.id !== customerId)));
    return;
  }
  await deleteDoc(doc(db, "procmanaCustomers", customerId));
}
