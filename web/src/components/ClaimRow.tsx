import { Link } from "react-router";
import { CLAIM_STATUS } from "../lib/claimText";
import { FINDING_TITLE } from "../lib/inspectionText";
import { formatDateTime } from "../lib/orderStatus";
import type { Claim } from "../lib/types";
import { Pill } from "./ui";

export const ClaimRowHead = () => (
    <div className="claim-row order-row-head" aria-hidden="true">
        <span>Mã đơn</span>
        <span>Sai lệch</span>
        <span>Trạng thái</span>
        <span>Cập nhật</span>
    </div>
);

export const ClaimRow = ({ claim }: { claim: Claim }) => {
    const status = CLAIM_STATUS[claim.status];
    const [first, ...others] = claim.findings.filter((f) => f.severity !== "info");
    return (
        <Link to={`/claims/${claim._id}`} className="claim-row">
            <span className="order-code">
                <span className="mono">{claim.orderId}</span>
                {claim.analysisMode === "demo" && <span className="order-sub">Dữ liệu demo</span>}
            </span>
            <span className="order-product">
                {first ? (FINDING_TITLE[first.category] ?? first.category) : "Không có sai lệch"}
                {others.length > 0 && <span className="order-sub">và {others.length} sai lệch khác</span>}
            </span>
            <span>
                <Pill tone={status.tone}>{status.label}</Pill>
            </span>
            <span className="order-sub">{formatDateTime(claim.updatedAt)}</span>
        </Link>
    );
};
