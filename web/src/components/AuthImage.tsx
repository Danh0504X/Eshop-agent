import { useEffect, useState } from "react";
import { fetchObjectUrl } from "../lib/api";

/** Shows a protected image: an <img> tag cannot send the auth header, so the file is fetched first. */
export const AuthImage = ({ src, alt }: { src: string; alt: string }) => {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        let created: string | null = null;
        fetchObjectUrl(src)
            .then((objectUrl) => {
                if (cancelled) return URL.revokeObjectURL(objectUrl);
                created = objectUrl;
                setUrl(objectUrl);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [src]);

    return url ? <img src={url} alt={alt} /> : <div className="image-placeholder" aria-label={alt} />;
};
