export const PERMISSIONS = [
  'can_delete',
  'can_view_finance',
  'can_manage_auctions',
  'can_manage_inventory',
  'can_manage_customers',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionMap = Record<Permission, boolean>;
export type StoreRole = 'OWNER' | 'STAFF';

/** Funcionário opera tudo, exceto excluir e ver o financeiro (doc 01, seção 3). */
const STAFF_DEFAULTS: PermissionMap = {
  can_delete: false,
  can_view_finance: false,
  can_manage_auctions: true,
  can_manage_inventory: true,
  can_manage_customers: true,
};

const OWNER_ALL: PermissionMap = {
  can_delete: true,
  can_view_finance: true,
  can_manage_auctions: true,
  can_manage_inventory: true,
  can_manage_customers: true,
};

export interface TenantContext {
  storeId: string;
  role: StoreRole;
  permissions: PermissionMap;
}

/** Só chaves conhecidas e valores booleanos passam; o resto é descartado. */
export function normalizePermissions(input: unknown): Partial<PermissionMap> {
  const result: Partial<PermissionMap> = {};
  if (typeof input !== 'object' || input === null) return result;
  const record = input as Record<string, unknown>;
  for (const key of PERMISSIONS) {
    const value = record[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/** O proprietário pode tudo; o funcionário recebe o padrão mais o que foi ajustado. */
export function effectivePermissions(role: StoreRole, stored: unknown): PermissionMap {
  if (role === 'OWNER') return { ...OWNER_ALL };
  return { ...STAFF_DEFAULTS, ...normalizePermissions(stored) };
}

export function can(tenant: TenantContext, permission: Permission): boolean {
  return tenant.permissions[permission];
}
