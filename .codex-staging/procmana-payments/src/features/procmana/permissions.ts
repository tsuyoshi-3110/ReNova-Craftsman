import type { CompanyMembership, Project } from "./types";

export function canViewProject(_member: CompanyMembership, projectId: string): boolean {
  return projectId.length > 0;
}

export function canViewFinancials(project: Project): boolean {
  return project.managementRole !== "none";
}

export function canEditProjects(_member: CompanyMembership): boolean {
  void _member;
  return true;
}

export function canEditEstimates(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin" || project.managementRole === "accounting";
}

export function canEditProjectInfo(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin";
}

export function canConfirmContract(project: Project): boolean {
  return project.managementRole === "owner"
    || (project.managementRole === "admin" && project.procNovaLinkStatus === "linked");
}

export function canManageBudget(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin";
}

export function canManageOrders(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin";
}

export function canManagePayments(project: Project): boolean {
  return project.managementRole === "owner" || project.managementRole === "admin" || project.managementRole === "accounting";
}

export function canManageAccess(project: Project): boolean {
  return project.managementRole === "owner";
}
