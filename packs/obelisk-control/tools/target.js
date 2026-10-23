// The app API the webapi tools talk to, set by `cloud.tenant` before each call.
let current = null;

export function setTarget(next) {
    current = next;
}

export function targetBase() {
    if (!current) throw "no cloud app selected";
    return current.base;
}

export function targetToken() {
    if (!current) throw "no cloud app selected";
    return current.token;
}
