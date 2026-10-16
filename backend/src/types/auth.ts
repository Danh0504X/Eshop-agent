import type { Role } from "../models/User";

/** The authenticated caller. The agent always acts with the principal of the user who started the inspection. */
export interface AuthPrincipal {
    userId: string;
    email: string;
    name: string;
    role: Role;
    shopId: string;
    warehouseIds: string[];
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthPrincipal;
        }
    }
}
