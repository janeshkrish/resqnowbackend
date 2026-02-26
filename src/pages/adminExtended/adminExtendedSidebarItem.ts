export type AdminExtendedSidebarItem = {
  id: string;
  label: string;
  to: string;
  matchPrefix: string;
  order: number;
};

export const adminExtendedSidebarItem: AdminExtendedSidebarItem = {
  id: "admin-extended-tools",
  label: "Admin Tools (Extended)",
  to: "/admin/extended/dashboard",
  matchPrefix: "/admin/extended",
  order: 999,
};

export function injectAdminExtendedSidebarItem<T extends { id: string; order?: number }>(
  existingItems: T[]
): Array<T | AdminExtendedSidebarItem> {
  if (existingItems.some((item) => item.id === adminExtendedSidebarItem.id)) {
    return existingItems;
  }

  return [...existingItems, adminExtendedSidebarItem].sort((left, right) => {
    const leftOrder = Number((left as { order?: number }).order || 0);
    const rightOrder = Number((right as { order?: number }).order || 0);
    return leftOrder - rightOrder;
  });
}

