// Shapes returned by the backend. The UI only displays what the backend decided.

export type Role = "owner" | "employee";

export interface User {
    userId: string;
    email: string;
    name: string;
    role: Role;
    shopId: string;
    warehouseIds: string[];
}

export interface Health {
    status: "ok" | "degraded";
    database: string;
    analysisMode: "real" | "demo";
    aiProvider: string | null;
    aiModel: string | null;
    planner: string;
    /** true: evidence may be attached as a file (demo); false: it must be recorded in the app. */
    allowFileEvidence?: boolean;
}
