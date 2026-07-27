export const constants = {
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
};

export function gzipSync() {
    throw new Error("gzip is unavailable in workflow JavaScript");
}

export function gunzipSync() {
    throw new Error("gzip is unavailable in workflow JavaScript");
}
