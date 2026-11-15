// obelisk-agent:tools/cloud.read:
//   func(path: list<string>) -> result<record { status: u16, body: string }, string>
//
// GET `/<path>` on the provisioner, for the shell's reads before a lifecycle command.
// Every response below 500 is returned for the shell to report; a failed request or a
// server error is an err and gets retried.
import { provisionerResponse } from "./client.js";

export default async function read(path) {
    if (path[0] !== "v1") throw `invalid provisioner path /${path.join("/")}`;
    return provisionerResponse("GET", path);
}
