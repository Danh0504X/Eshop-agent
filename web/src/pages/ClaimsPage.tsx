import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ClaimRow, ClaimRowHead } from "../components/ClaimRow";
import { IconClaim } from "../components/icons";
import { EmptyState, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { CLAIM_STATUS, CLAIM_STATUSES } from "../lib/claimText";
import type { Claim } from "../lib/types";

/** The claims AI drafted from inspections, newest activity first. The status filter is kept in the URL. */
export const ClaimsPage = () => {
    const [params, setParams] = useSearchParams();
    const status = params.get("status") ?? "";
    const [claims, setClaims] = useState<Claim[] | null>(null);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        setClaims(null);
        setError(null);
        api.listClaims({ status })
            .then((result) => {
                if (!cancelled) setClaims(result.claims);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e);
            });
        return () => {
            cancelled = true;
        };
    }, [status]);

    return (
        <>
            <PageHeader title="Khiếu nại" subtitle="Bản nháp do AI tạo, chỉ có hiệu lực sau khi chủ shop duyệt." />
            <div className="list-filters">
                <select
                    value={status}
                    onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {}, { replace: true })}
                    aria-label="Lọc theo trạng thái"
                >
                    <option value="">Tất cả trạng thái</option>
                    {CLAIM_STATUSES.map((s) => (
                        <option key={s} value={s}>
                            {CLAIM_STATUS[s].label}
                        </option>
                    ))}
                </select>
            </div>
            <ErrorAlert error={error} />

            {claims === null && !error && (
                <div className="inline-loading">
                    <Spinner />
                </div>
            )}

            {claims?.length === 0 && (
                <div className="card">
                    <EmptyState
                        icon={<IconClaim size={32} />}
                        title={status ? "Không có khiếu nại ở trạng thái này" : "Chưa có khiếu nại"}
                    >
                        {status
                            ? "Hãy chọn trạng thái khác."
                            : "Khi kiểm tra bằng AI phát hiện sai lệch, khiếu nại nháp sẽ xuất hiện ở đây."}
                    </EmptyState>
                </div>
            )}

            {claims && claims.length > 0 && (
                <div className="card order-list">
                    <ClaimRowHead />
                    {claims.map((claim) => (
                        <ClaimRow key={claim._id} claim={claim} />
                    ))}
                </div>
            )}
        </>
    );
};
