import { useEffect, useState } from "react";
import { fetchObjectUrl } from "../lib/api";
import { ErrorAlert, Spinner } from "./ui";

/** Plays a protected video: a <video> tag cannot send the auth header, so the file is fetched first. */
export const AuthVideo = ({ src }: { src: string }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
        let cancelled = false;
        let created: string | null = null;
        setUrl(null);
        setError(null);
        fetchObjectUrl(src)
            .then((objectUrl) => {
                if (cancelled) return URL.revokeObjectURL(objectUrl);
                created = objectUrl;
                setUrl(objectUrl);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e);
            });
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [src]);

    if (error) return <ErrorAlert error={error} />;
    return (
        <div className="evidence-video">
            {url ? (
                <video src={url} controls playsInline preload="metadata" />
            ) : (
                <div className="evidence-video-loading">
                    <Spinner />
                </div>
            )}
        </div>
    );
};
