import type { Role } from "../models/User";
import type { AuthPrincipal } from "../types/auth";
import { ApiError, forbidden } from "../utils/errors";

interface Scoped {
    shopId: string;
    warehouseId: string;
}

/** Mongo filter restricting a query to what the principal may see. */
export const scopeFilter = (principal: AuthPrincipal): Record<string, unknown> =>
    principal.role === "owner"
        ? { shopId: principal.shopId }
        : { shopId: principal.shopId, warehouseId: { $in: principal.warehouseIds } };

export const canAccessWarehouse = (principal: AuthPrincipal, warehouseId: string): boolean =>
    principal.role === "owner" || principal.warehouseIds.includes(warehouseId);

/**
 * Enforce shop and warehouse boundaries on a loaded record.
 * Another shop's record is reported as "not found" so its existence is not leaked;
 * a record in the caller's shop but outside their warehouses is a 403.
 */
export const assertScope = (principal: AuthPrincipal, record: Scoped, what = "Resource"): void => {
    if (record.shopId !== principal.shopId) throw new ApiError("NOT_FOUND", `${what} not found`);
    if (!canAccessWarehouse(principal, record.warehouseId)) {
        throw forbidden(`Your account is not assigned to warehouse ${record.warehouseId}`);
    }
};

export const assertRole = (principal: AuthPrincipal, roles: Role[], action: string): void => {
    if (!roles.includes(principal.role)) {
        throw forbidden(`Only ${roles.join(" or ")} accounts can ${action}`);
    }
};
