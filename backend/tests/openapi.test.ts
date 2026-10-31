import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/app";
import { openApiDocument } from "../src/docs/openapi";
import { connectTestDb, createUser, disconnectTestDb, type TestUser } from "./helpers";

let owner: TestUser;

beforeAll(async () => {
    await connectTestDb();
    owner = await createUser({ role: "owner", shopId: "shop-docs" });
});
afterAll(disconnectTestDb);

const REQUIRED = [
    "post /api/scans",
    "post /api/orders",
    "get /api/orders",
    "get /api/orders/{orderId}",
    "post /api/orders/{orderId}/media",
    "get /api/orders/{orderId}/media",
    "post /api/orders/{orderId}/inspect",
    "get /api/inspections/{inspectionId}",
    "post /api/inspections/{inspectionId}/retry",
    "post /api/claims/{claimId}/approve",
    "post /api/claims/{claimId}/reject",
    "get /api/claims/{claimId}/report",
    "get /api/health",
];

const operations = Object.entries(openApiDocument.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => ({ method, path })),
);

describe("OpenAPI documentation", () => {
    it("documents every endpoint required by the specification", () => {
        const documented = operations.map((o) => `${o.method} ${o.path}`);
        for (const op of REQUIRED) expect(documented).toContain(op);
    });

    it("serves the JSON document and the Swagger UI", async () => {
        const json = await request(app).get("/api/openapi.json");
        expect(json.status).toBe(200);
        expect(json.body.openapi).toBe("3.0.3");
        const ui = await request(app).get("/api/docs/");
        expect(ui.status).toBe(200);
        expect(ui.text).toMatch(/swagger-ui/);
    });

    it("every documented operation is an actual route", async () => {
        const fakeId = "0123456789abcdef01234567";
        for (const { method, path } of operations) {
            const url = path.replace(/\{[^}]+\}/g, (m) => (m === "{orderId}" || m === "{frameId}" ? "X-1" : fakeId));
            const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)
                [method](url)
                .set("Authorization", `Bearer ${owner.token}`);
            // Business 404s (missing order/claim) are fine; the router's "Route ... not found" is not.
            expect(res.body?.message ?? "", `${method.toUpperCase()} ${path}`).not.toMatch(/^Route /);
        }
    });
});
