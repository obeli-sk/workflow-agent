// The Obelisk API the webapi tools talk to: TARGET_OBELISK_* unless the cloud tenant proxy overrides it.
let override = null;

export function setTarget(next) {
    override = next;
}

export function targetBase() {
    return override ? override.base : process.env["TARGET_OBELISK_API_URL"];
}

export function targetToken() {
    return override ? override.token : process.env["TARGET_OBELISK_TOKEN"];
}
