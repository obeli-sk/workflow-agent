export function isDeploymentUpload(path) {
    return /^\/v1\/(files\/sha256:[0-9a-f]{64}|deployments\/Dep_[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(path);
}
