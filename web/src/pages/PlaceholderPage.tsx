import { EmptyState, PageHeader } from "../components/ui";

/** Temporary screen for routes whose page is built in a later step of the redesign. */
export const PlaceholderPage = ({ title }: { title: string }) => (
    <>
        <PageHeader title={title} />
        <div className="card">
            <EmptyState title="Màn hình đang được xây dựng">Chức năng này sẽ có ở bước tiếp theo.</EmptyState>
        </div>
    </>
);
