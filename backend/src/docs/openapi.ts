/**
 * OpenAPI 3.0 description of the FixIt REST API, served at /api/openapi.json and /api/docs.
 * Response bodies use the envelope { status: "success", message?, data }.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const id = { type: "string", pattern: "^[a-f0-9]{24}$" };

const ok = (description: string, data: Schema = { type: "object" }, status = "200") => ({
    [status]: {
        description,
        content: {
            "application/json": {
                schema: {
                    type: "object",
                    properties: { status: { type: "string", example: "success" }, message: { type: "string" }, data },
                },
            },
        },
    },
});

const errors = (...codes: number[]) =>
    Object.fromEntries(
        codes.map((code) => [
            String(code),
            { description: ERROR_TEXT[code] ?? "Error", content: { "application/json": { schema: ref("Error") } } },
        ]),
    );

const ERROR_TEXT: Record<number, string> = {
    400: "Validation error",
    401: "Missing or invalid token",
    403: "Forbidden (role, warehouse or approval requirement)",
    404: "Not found (or belongs to another shop)",
    409: "Conflict or invalid state transition",
    413: "File too large",
    415: "Unsupported media type",
    429: "Rate limited",
};

const pathParam = (name: string, schema: Schema = { type: "string" }) => ({ name, in: "path", required: true, schema });
const jsonBody = (schema: Schema) => ({ required: true, content: { "application/json": { schema } } });
const reasonBody = jsonBody({
    type: "object",
    required: ["reason"],
    properties: { reason: { type: "string", minLength: 5, maxLength: 1000 } },
});

export const openApiDocument = {
    openapi: "3.0.3",
    info: {
        title: "FixIt AI Agent API",
        version: "1.0.0",
        description:
            "AI-assisted return inspection. The agent compares outbound packing evidence with return-opening evidence and " +
            "drafts claims for human review. Findings are visual discrepancies, never proof of wrongdoing. Consequential " +
            "actions (approval, final determinations, evidence deletion/replacement) require an authorized human. " +
            "Check GET /api/health for the active analysis mode (real AI vs. demo data).",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    tags: [
        { name: "System" },
        { name: "Auth" },
        { name: "Scans" },
        { name: "Orders" },
        { name: "Evidence" },
        { name: "Inspections" },
        { name: "Claims" },
    ],
    paths: {
        "/api/health": {
            get: {
                tags: ["System"],
                summary: "Health, database status and active analysis mode",
                security: [],
                responses: {
                    "200": {
                        description: "Healthy",
                        content: { "application/json": { schema: ref("Health") } },
                    },
                    "503": { description: "Database unavailable" },
                },
            },
        },
        "/api/auth/login": {
            post: {
                tags: ["Auth"],
                summary: "Log in and receive a JWT",
                security: [],
                requestBody: jsonBody({
                    type: "object",
                    required: ["email", "password"],
                    properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
                }),
                responses: {
                    ...ok("Token issued", {
                        type: "object",
                        properties: { token: { type: "string" }, user: ref("Principal") },
                    }),
                    ...errors(400, 401),
                },
            },
        },
        "/api/auth/me": {
            get: {
                tags: ["Auth"],
                summary: "Current user",
                responses: {
                    ...ok("Current principal", { type: "object", properties: { user: ref("Principal") } }),
                    ...errors(401),
                },
            },
        },
        "/api/scans": {
            post: {
                tags: ["Scans"],
                summary: "Record a shipping-label scan (packing: before creating the order; return: finds the order)",
                description:
                    "Every order and evidence video is bound to a scan of its label instead of the AI reading the code " +
                    "from footage. A scan expires after SCAN_SESSION_TTL_MINUTES. Packing scans of a code that already " +
                    "has an order return 409 (with the order ID when the caller may open it).",
                requestBody: jsonBody(ref("CreateScan")),
                responses: {
                    ...ok(
                        "Scan recorded",
                        {
                            type: "object",
                            properties: { scan: ref("Scan"), order: { ...ref("Order"), nullable: true } },
                        },
                        "201",
                    ),
                    ...errors(400, 401, 403, 404, 409),
                },
            },
        },
        "/api/orders": {
            get: {
                tags: ["Orders"],
                summary: "List orders in the caller's shop (employees: assigned warehouses only)",
                parameters: [
                    {
                        name: "status",
                        in: "query",
                        schema: {
                            type: "string",
                            enum: ["none", "pending", "processing", "needs_review", "completed", "failed"],
                        },
                    },
                    {
                        name: "search",
                        in: "query",
                        schema: { type: "string" },
                        description: "Order ID or tracking code",
                    },
                    { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
                ],
                responses: {
                    ...ok("Orders", { type: "object", properties: { orders: { type: "array", items: ref("Order") } } }),
                    ...errors(401),
                },
            },
            post: {
                tags: ["Orders"],
                summary: "Create an order from a packing scan (tracking code from the scan, order ID generated)",
                requestBody: jsonBody(ref("CreateOrder")),
                responses: {
                    ...ok("Created", { type: "object", properties: { order: ref("Order") } }, "201"),
                    ...errors(400, 401, 403, 409),
                },
            },
        },
        "/api/orders/{orderId}": {
            get: {
                tags: ["Orders"],
                summary: "Get one order (customer data is returned to owners only)",
                parameters: [pathParam("orderId")],
                responses: {
                    ...ok("Order", { type: "object", properties: { order: ref("Order") } }),
                    ...errors(401, 403, 404),
                },
            },
        },
        "/api/orders/{orderId}/media": {
            get: {
                tags: ["Evidence"],
                summary: "List evidence for an order",
                parameters: [
                    pathParam("orderId"),
                    { name: "includeInactive", in: "query", schema: { type: "boolean" } },
                ],
                responses: {
                    ...ok("Evidence", {
                        type: "object",
                        properties: { media: { type: "array", items: ref("Media") } },
                    }),
                    ...errors(401, 403, 404),
                },
            },
            post: {
                tags: ["Evidence"],
                summary: "Upload an outbound or return evidence video",
                description:
                    "Accepted: mp4, mov, webm, mkv, avi (content is verified, not just the extension). Existing evidence is never " +
                    "overwritten silently: replacing requires replaceExisting=true and a replacementReason; the old file is kept as superseded.",
                parameters: [pathParam("orderId")],
                requestBody: {
                    required: true,
                    content: {
                        "multipart/form-data": {
                            schema: {
                                type: "object",
                                required: ["file", "type"],
                                properties: {
                                    file: { type: "string", format: "binary" },
                                    type: { type: "string", enum: ["outbound", "return"] },
                                    replaceExisting: { type: "boolean" },
                                    replacementReason: { type: "string" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    ...ok("Uploaded and linked", { type: "object", properties: { media: ref("Media") } }, "201"),
                    ...errors(400, 401, 403, 404, 409, 413, 415),
                },
            },
        },
        "/api/media/{mediaId}/file": {
            get: {
                tags: ["Evidence"],
                summary: "Stream an evidence video",
                parameters: [pathParam("mediaId", id)],
                responses: {
                    "200": { description: "Video stream", content: { "video/*": {} } },
                    ...errors(401, 403, 404),
                },
            },
        },
        "/api/media/{mediaId}/frames/{frameId}": {
            get: {
                tags: ["Evidence"],
                summary: "Get an extracted frame image",
                parameters: [pathParam("mediaId", id), pathParam("frameId", { type: "string", example: "RET-03" })],
                responses: { "200": { description: "JPEG", content: { "image/jpeg": {} } }, ...errors(401, 403, 404) },
            },
        },
        "/api/media/{mediaId}": {
            delete: {
                tags: ["Evidence"],
                summary: "Delete evidence (owner only, explicit confirmation and reason required)",
                parameters: [pathParam("mediaId", id)],
                requestBody: jsonBody({
                    type: "object",
                    required: ["reason", "confirm"],
                    properties: {
                        reason: { type: "string", minLength: 5 },
                        confirm: { type: "boolean", enum: [true] },
                    },
                }),
                responses: { ...ok("Deleted"), ...errors(400, 401, 403, 404) },
            },
        },
        "/api/orders/{orderId}/inspect": {
            post: {
                tags: ["Inspections"],
                summary: "Start the FixIt agent for an order (asynchronous)",
                description:
                    "Returns 202 with the queued inspection. Poll GET /api/inspections/{inspectionId}. Rate limited per user.",
                parameters: [pathParam("orderId")],
                responses: {
                    ...ok("Queued", { type: "object", properties: { inspection: ref("Inspection") } }, "202"),
                    ...errors(401, 403, 404, 409, 429),
                },
            },
        },
        "/api/orders/{orderId}/inspections": {
            get: {
                tags: ["Inspections"],
                summary: "Inspection history for an order",
                parameters: [pathParam("orderId")],
                responses: {
                    ...ok("Inspections", {
                        type: "object",
                        properties: { inspections: { type: "array", items: ref("Inspection") } },
                    }),
                    ...errors(401, 403, 404),
                },
            },
        },
        "/api/inspections/{inspectionId}": {
            get: {
                tags: ["Inspections"],
                summary: "Inspection status and results (poll this)",
                parameters: [pathParam("inspectionId", id)],
                responses: {
                    ...ok("Inspection", { type: "object", properties: { inspection: ref("Inspection") } }),
                    ...errors(400, 401, 403, 404),
                },
            },
        },
        "/api/inspections/{inspectionId}/retry": {
            post: {
                tags: ["Inspections"],
                summary: "Retry a failed or needs_review inspection (e.g. after uploading replacement evidence)",
                parameters: [pathParam("inspectionId", id)],
                responses: {
                    ...ok("Queued", { type: "object", properties: { inspection: ref("Inspection") } }, "202"),
                    ...errors(401, 403, 404, 409, 429),
                },
            },
        },
        "/api/claims": {
            get: {
                tags: ["Claims"],
                summary: "List claims",
                parameters: [
                    {
                        name: "status",
                        in: "query",
                        schema: {
                            type: "string",
                            enum: ["draft", "pending_approval", "approved", "submitted", "rejected", "resolved"],
                        },
                    },
                    { name: "orderId", in: "query", schema: { type: "string" } },
                    { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
                ],
                responses: {
                    ...ok("Claims", { type: "object", properties: { claims: { type: "array", items: ref("Claim") } } }),
                    ...errors(401),
                },
            },
        },
        "/api/claims/{claimId}": {
            get: {
                tags: ["Claims"],
                summary: "Get a claim",
                parameters: [pathParam("claimId", id)],
                responses: {
                    ...ok("Claim", { type: "object", properties: { claim: ref("Claim") } }),
                    ...errors(400, 401, 403, 404),
                },
            },
        },
        "/api/claims/{claimId}/report": {
            get: {
                tags: ["Claims"],
                summary: "Download the AI-generated draft PDF report (audited)",
                parameters: [pathParam("claimId", id)],
                responses: {
                    "200": { description: "PDF", content: { "application/pdf": {} } },
                    ...errors(401, 403, 404),
                },
            },
        },
        "/api/claims/{claimId}/approve": {
            post: {
                tags: ["Claims"],
                summary: "Approve a draft claim (owner only, reason required)",
                parameters: [pathParam("claimId", id)],
                requestBody: jsonBody({
                    type: "object",
                    required: ["reason"],
                    properties: {
                        reason: { type: "string", minLength: 5 },
                        finalDetermination: {
                            type: "string",
                            enum: [
                                "no_determination",
                                "discrepancy_confirmed_by_reviewer",
                                "no_discrepancy",
                                "inconclusive",
                            ],
                            description: "Recorded only by a human reviewer; the agent never sets it.",
                        },
                    },
                }),
                responses: {
                    ...ok("Approved", { type: "object", properties: { claim: ref("Claim") } }),
                    ...errors(400, 401, 403, 404, 409),
                },
            },
        },
        "/api/claims/{claimId}/reject": {
            post: {
                tags: ["Claims"],
                summary: "Reject a draft claim (owner only, reason required)",
                parameters: [pathParam("claimId", id)],
                requestBody: reasonBody,
                responses: {
                    ...ok("Rejected", { type: "object", properties: { claim: ref("Claim") } }),
                    ...errors(400, 401, 403, 404, 409),
                },
            },
        },
        "/api/claims/{claimId}/mark-submitted": {
            post: {
                tags: ["Claims"],
                summary: "Record that a human submitted the approved claim elsewhere (FixIt never submits externally)",
                parameters: [pathParam("claimId", id)],
                requestBody: jsonBody({
                    type: "object",
                    properties: { externalReference: { type: "string" }, note: { type: "string" } },
                }),
                responses: {
                    ...ok("Recorded", { type: "object", properties: { claim: ref("Claim") } }),
                    ...errors(400, 401, 403, 404, 409),
                },
            },
        },
        "/api/claims/{claimId}/resolve": {
            post: {
                tags: ["Claims"],
                summary: "Resolve an approved or submitted claim (owner only)",
                parameters: [pathParam("claimId", id)],
                requestBody: reasonBody,
                responses: {
                    ...ok("Resolved", { type: "object", properties: { claim: ref("Claim") } }),
                    ...errors(400, 401, 403, 404, 409),
                },
            },
        },
    },
    components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        schemas: {
            Error: {
                type: "object",
                properties: {
                    statusCode: { type: "integer" },
                    code: { type: "string", example: "VALIDATION_ERROR" },
                    message: { type: "string" },
                    errors: { type: "array", items: { type: "object" } },
                },
            },
            Health: {
                type: "object",
                properties: {
                    status: { type: "string", enum: ["ok", "degraded"] },
                    database: { type: "string" },
                    analysisMode: { type: "string", enum: ["real", "demo"] },
                    aiModel: { type: "string", nullable: true },
                    planner: { type: "string" },
                },
            },
            Principal: {
                type: "object",
                properties: {
                    userId: { type: "string" },
                    email: { type: "string" },
                    name: { type: "string" },
                    role: { type: "string", enum: ["owner", "employee"] },
                    shopId: { type: "string" },
                    warehouseIds: { type: "array", items: { type: "string" } },
                },
            },
            CreateScan: {
                type: "object",
                required: ["code", "purpose", "method"],
                properties: {
                    code: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$", example: "GHN12345678" },
                    purpose: { type: "string", enum: ["packing", "return"] },
                    method: {
                        type: "string",
                        enum: ["camera", "image_file", "hand_scanner", "manual"],
                        description: "manual = typed because the label could not be scanned",
                    },
                },
            },
            Scan: {
                type: "object",
                properties: {
                    id,
                    code: { type: "string" },
                    purpose: { type: "string", enum: ["packing", "return"] },
                    method: { type: "string" },
                    manualEntry: { type: "boolean" },
                    orderId: { type: "string", nullable: true },
                    scannedAt: { type: "string", format: "date-time" },
                    expiresAt: { type: "string", format: "date-time" },
                },
            },
            CreateOrder: {
                allOf: [
                    ref("OrderDetails"),
                    {
                        type: "object",
                        required: ["scanId"],
                        properties: {
                            scanId: {
                                ...id,
                                description: "A packing scan made by the caller; supplies the tracking code",
                            },
                        },
                    },
                ],
            },
            OrderDetails: {
                type: "object",
                required: ["warehouseId", "product", "expectedQuantity"],
                properties: {
                    warehouseId: { type: "string", example: "wh-hcm" },
                    product: {
                        type: "object",
                        required: ["name"],
                        properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                            sku: { type: "string" },
                            model: { type: "string" },
                            color: { type: "string" },
                        },
                    },
                    expectedQuantity: { type: "integer", minimum: 1 },
                    expectedAccessories: { type: "array", items: { type: "string" } },
                    customer: {
                        type: "object",
                        description: "Personal data: never sent to the AI provider; excluded from reports.",
                        properties: {
                            name: { type: "string" },
                            phone: { type: "string" },
                            address: { type: "string" },
                        },
                    },
                },
            },
            Order: {
                allOf: [
                    ref("OrderDetails"),
                    {
                        type: "object",
                        properties: {
                            _id: { type: "string" },
                            orderId: { type: "string", example: "ORD-261030-7KQ2" },
                            trackingCode: { type: "string", example: "GHN12345678" },
                            trackingScan: {
                                type: "object",
                                properties: {
                                    method: { type: "string" },
                                    manualEntry: { type: "boolean" },
                                    scannedAt: { type: "string", format: "date-time" },
                                },
                            },
                            shopId: { type: "string" },
                            inspectionStatus: { type: "string" },
                            latestInspectionId: { type: "string" },
                            latestClaimId: { type: "string" },
                            packingMedia: { type: "array", items: { type: "string" } },
                            returnMedia: { type: "array", items: { type: "string" } },
                        },
                    },
                ],
            },
            Media: {
                type: "object",
                properties: {
                    _id: { type: "string" },
                    orderId: { type: "string" },
                    type: { type: "string", enum: ["outbound", "return"] },
                    status: { type: "string" },
                    mimeType: { type: "string" },
                    sizeBytes: { type: "integer" },
                    sha256: { type: "string" },
                    metadata: { type: "object" },
                    frames: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                frameId: { type: "string" },
                                timestampSec: { type: "number" },
                                brightness: { type: "number" },
                                sharpness: { type: "number" },
                                quality: { type: "string" },
                            },
                        },
                    },
                    quality: { type: "object" },
                    fileUrl: { type: "string" },
                },
            },
            Finding: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    category: { type: "string" },
                    severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
                    confidence: { type: "number", description: "Model-reported; not a calibrated probability" },
                    certainty: { type: "string", enum: ["observed", "uncertain"] },
                    description: { type: "string" },
                    evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                frameId: { type: "string" },
                                type: { type: "string" },
                                timestampSec: { type: "number" },
                            },
                        },
                    },
                    nature: { type: "string", enum: ["visual_discrepancy"] },
                },
            },
            Inspection: {
                type: "object",
                properties: {
                    _id: { type: "string" },
                    orderId: { type: "string" },
                    status: { type: "string", enum: ["pending", "processing", "needs_review", "completed", "failed"] },
                    workflowState: { type: "string" },
                    attempt: { type: "integer" },
                    analysisMode: { type: "string", enum: ["real", "demo"] },
                    planner: { type: "string", enum: ["llm", "deterministic"] },
                    evidenceValidation: { type: "object" },
                    outboundAnalysis: { type: "object" },
                    returnAnalysis: { type: "object" },
                    comparison: {
                        type: "object",
                        properties: { findings: { type: "array", items: ref("Finding") }, summary: { type: "string" } },
                    },
                    confidence: { type: "object" },
                    escalation: { type: "object" },
                    reviewTask: { type: "object" },
                    frameReferences: { type: "array", items: { type: "object" } },
                    summary: { type: "string" },
                    agentNarrative: { type: "string" },
                    recommendedAction: { type: "string" },
                    claimId: { type: "string" },
                    agentLog: { type: "array", items: { type: "object" } },
                    statusUrl: { type: "string" },
                },
            },
            Claim: {
                type: "object",
                properties: {
                    _id: { type: "string" },
                    orderId: { type: "string" },
                    inspectionId: { type: "string" },
                    status: {
                        type: "string",
                        enum: ["draft", "pending_approval", "approved", "submitted", "rejected", "resolved"],
                    },
                    summary: { type: "string" },
                    findings: { type: "array", items: ref("Finding") },
                    uncertaintyNotes: { type: "array", items: { type: "string" } },
                    aiGenerated: { type: "boolean" },
                    analysisMode: { type: "string" },
                    redaction: { type: "object" },
                    approval: { type: "object" },
                    history: { type: "array", items: { type: "object" } },
                    reportUrl: { type: "string", nullable: true },
                },
            },
        },
    },
};
