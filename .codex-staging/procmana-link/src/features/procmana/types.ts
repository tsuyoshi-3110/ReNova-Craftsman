export type SiteRole = "owner" | "admin" | "member" | "none";
export type ManagementRole = "owner" | "admin" | "accounting" | "none";
export type UserRole = "owner" | "admin" | "accounting" | "member";

export type ProjectStatus =
  | "draft_estimate" | "estimate_submitted" | "negotiating" | "lost"
  | "contracted" | "contract_cancelled" | "budgeting" | "ordering" | "pre_construction"
  | "in_progress" | "completed" | "final_invoiced" | "paid" | "closed";

export type ContractState = "none" | "active" | "cancelled";

/** ログイン中のProcNova共通アカウント。権限はユーザー固定ではなく工事ごとに判定する。 */
export type CompanyMembership = {
  uid: string;
  companyId: string;
  companyName: string;
  displayName: string;
  email: string;
  role: UserRole;
  canManageUsers: boolean;
  allowedProjectIds: string[];
  active: boolean;
};

export type CostActualMode = "workType" | "vendor";

export type CostActuals = {
  mode: CostActualMode;
  workType: Record<string, number>;
  vendor: Record<string, number>;
  /** 月別の出来高払い。キーは "YYYY-MM"、値は入力単位（mode）のキーごとの支払額 */
  monthly: Record<string, Record<string, number>>;
};

export type InvoiceStatus = "draft" | "issued";

/** monthly＝月次出来高請求（1次請負以下）、milestone＝出来高割合の分割請求（元請） */
export type BillingType = "monthly" | "milestone";

export type InvoiceMilestone = {
  id: string;
  name: string;
  percent: number;
};

/**
 * 工種ごとの出来高計上ルール。
 * progress＝施工進捗（工程写真）に連動、schedule＝工期按分、
 * startEnd＝着工50%・完了100%、manual＝手入力
 */
export type WorkTypeBillingRule = "progress" | "schedule" | "startEnd" | "manual";

export type WorkTypeBilling = {
  rule: WorkTypeBillingRule;
  /** startEnd・manual のときの計上率 */
  percent: number;
};

export type InvoiceSettings = {
  billingType: BillingType;
  /** 締め日。0＝末日、1〜28＝その日 */
  closingDay: number;
  milestones: InvoiceMilestone[];
  /** 工種名 → 出来高計上ルール */
  workTypeBilling: Record<string, WorkTypeBilling>;
  /** 請求書に印字する自社情報（インボイス登録番号・振込先・FAX） */
  registrationNumber: string;
  fax: string;
  bankName: string;
  branchName: string;
  accountType: string;
  accountNumber: string;
  accountHolder: string;
};

/** 出来高請求書の明細（工種単位）。契約金額に対する累計・今回請求を管理する */
export type InvoiceLine = {
  id: string;
  name: string;
  contractQuantity: number;
  contractUnit: string;
  contractAmount: number;
  /** 前回までの請求累計（税抜・発行時点のスナップショット） */
  previousAmount: number;
  /** 今回請求額（税抜） */
  currentAmount: number;
};

export type Invoice = {
  id: string;
  projectId: string;
  invoiceNumber: string;
  title: string;
  billingDate: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  paymentDueDate: string;
  notes: string;
  billingType: BillingType;
  /** 分割請求のとき、対応するマイルストーンID */
  milestoneId: string | null;
  /** 工種別の出来高請求明細 */
  lines: InvoiceLine[];
  status: InvoiceStatus;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentMethod = "bank_transfer" | "cash" | "check" | "card" | "other";
export type PaymentStatus = "recorded" | "cancelled";

/** 発行済み請求書に対する入金記録。取消時も削除せず監査履歴として保持する。 */
export type Payment = {
  id: string;
  projectId: string;
  companyId: string;
  ownerUid: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentDate: string;
  amount: number;
  method: PaymentMethod;
  payerName: string;
  referenceNumber: string;
  notes: string;
  status: PaymentStatus;
  recordedBy: string;
  recordedByName: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDocumentCategory = "estimate" | "contract" | "order" | "invoice" | "drawing" | "report" | "permit" | "photo" | "other";
export type ProjectDocumentStatus = "active" | "archived";

/** ProcManaの工事書類台帳。ファイル本体はFirebase Storageへ保存する。 */
export type ProjectDocument = {
  id: string;
  projectId: string;
  companyId: string;
  ownerUid: string;
  name: string;
  originalName: string;
  category: ProjectDocumentCategory;
  description: string;
  storagePath: string;
  fileUrl: string;
  contentType: string;
  size: number;
  status: ProjectDocumentStatus;
  uploadedBy: string;
  uploadedByName: string;
  archivedAt: string | null;
  archivedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** ProcNovaの工事関係書類保管庫に保存されているファイル。 */
export type ProcNovaVaultDocument = {
  id: string;
  projectId: string;
  name: string;
  category: ProjectDocumentCategory;
  description: string;
  storagePath: string;
  fileUrl: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedByName: string;
  folderId: string | null;
  commentCount: number;
  createdAt: string;
};

export type ProcNovaVaultFolder = {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

/** ProcNovaのプロフィール（reNovaMember/{uid}.profile）と共有する自社情報 */
export type CompanySenderProfile = {
  companyName: string;
  companyAddress: string;
  phone: string;
  logoUrl: string;
  fullName: string;
  /** 以下は請求書・発注書で使用。ProcNovaのプロフィールにも保存され、全工事で使い回す */
  fax: string;
  registrationNumber: string;
  bankName: string;
  branchName: string;
  accountType: string;
  accountNumber: string;
  accountHolder: string;
};

/** 顧客マスタ。会社（ログインユーザー）単位で登録し、工事に使い回す */
export type Customer = {
  id: string;
  ownerUid: string;
  name: string;
  /** 郵便番号（ハイフンなし7桁で保持） */
  postalCode: string;
  address: string;
  contact: string;
  phone: string;
  email: string;
  registrationNumber: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFinancials = {
  estimateAmount: number;
  contractAmount: number;
  plannedCost: number;
  actualCost: number;
  invoicedAmount: number;
  paidAmount: number;
};

export type Project = ProjectFinancials & {
  id: string;
  companyId: string;
  ownerUid: string;
  siteRole: SiteRole;
  managementRole: ManagementRole;
  source: "procmana" | "procnova";
  name: string;
  customerName: string;
  customerContact: string;
  customerAddress: string;
  siteAddress: string;
  phone: string;
  email: string;
  managerId: string;
  managerName: string;
  estimateDueDate: string;
  plannedStartDate: string;
  plannedEndDate: string;
  winProbability: number;
  notes: string;
  status: ProjectStatus;
  contractState: ContractState;
  activeContractId: string | null;
  lastContractId: string | null;
  contractConfirmedAt: string | null;
  contractCancelledAt: string | null;
  contractCancelledBy: string | null;
  constructionProgress: number;
  billingProgress: number;
  procNovaProjectId: string | null;
  procNovaProjectUrl: string | null;
  procNovaLinkStatus: "not_linked" | "linked" | "failed";
  siteShareCode: string | null;
  budgetWorkTypeVendors: Record<string, string>;
  budgetWorkTypeOrder: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectMember = {
  uid: string;
  displayName: string;
  email: string;
  siteRole: SiteRole;
  managementRole: ManagementRole;
  joinedBy: "owner" | "management_invite";
  active: boolean;
};

export type ManagementInvite = {
  code: string;
  projectId: string;
  projectName: string;
  role: Exclude<ManagementRole, "owner" | "none">;
  expiresAt: string;
};

export type EstimateLine = {
  id: string;
  parentId: string | null;
  lineType: "detail" | "heading";
  sortOrder: number;
  workType: string;
  itemName: string;
  specification: string;
  specNumber: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  costUnitPrice: number;
  costAmount: number;
  profit: number;
  profitRate: number;
  notes: string;
  conversionRate?: number;
};

export type Estimate = {
  id: string;
  companyId: string;
  projectId: string;
  estimateNumber: string;
  estimateDate: string;
  validUntil: string;
  subject: string;
  paymentTerms: string;
  notes: string;
  defaultCostRate: number;
  workTypeCostRates: Record<string, number>;
  lines: EstimateLine[];
  subtotal: number;
  discount: number;
  taxRate: number;
  tax: number;
  total: number;
  status: "draft" | "submitted" | "adopted";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Contract = {
  id: string;
  companyId: string;
  projectId: string;
  estimateId: string;
  amount: number;
  contractDate: string;
  startDate: string;
  plannedEndDate: string;
  paymentTerms: string;
  contractFileUrl: string | null;
  notes: string;
  version: number;
  confirmedAt: string;
  confirmedBy: string;
};

export type ExecutionBudgetLine = {
  id: string;
  projectId: string;
  sourceEstimateId: string | null;
  estimateLineId: string | null;
  /** 見積明細の並び順を継承した表示順。手動追加行は追加時刻で末尾に付く */
  sortOrder: number;
  workType: string;
  itemName: string;
  specification: string;
  specNumber: string;
  unit: string;
  estimateQuantity: number;
  estimateCostUnitPrice: number;
  estimateCost: number;
  budgetQuantity: number;
  budgetUnitPrice: number;
  budgetCost: number;
  plannedVendor: string;
  orderedAmount: number;
  actualCost: number;
  variance: number;
  notes: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseOrderStatus = "draft" | "confirmed" | "cancelled";

export type PurchaseOrderLine = {
  id: string;
  budgetLineId: string;
  workType: string;
  itemName: string;
  specification: string;
  specNumber: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  notes: string;
};

export type PurchaseOrder = {
  id: string;
  projectId: string;
  companyId: string;
  ownerUid: string;
  vendorKey: string;
  vendorName: string;
  orderNumber: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  deliveryStartDate: string;
  deliveryEndDate: string;
  siteAddress: string;
  paymentTerms: string;
  notes: string;
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  lines: PurchaseOrderLine[];
  sourceBudgetSignature: string;
  revisionOfOrderId: string | null;
  lastConfirmedSignature: string | null;
  lastConfirmedOrderId: string | null;
  version: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
};

/** 金額・原価・利益を意図的に含めないProcNova送信DTO。 */
export type ProcNovaProjectInput = {
  procManaProjectId: string;
  projectName: string;
  siteAddress: string;
  startDate: string;
  plannedEndDate: string;
  supervisorName: string;
  customerName: string;
};

export type ProcNovaLinkResult = {
  procNovaProjectId: string;
  procNovaProjectUrl: string;
  siteShareCode: string;
  linkedAt: string;
  status: "linked";
};

export type ConversionMode = "order_rate" | "markup" | "target_margin";
