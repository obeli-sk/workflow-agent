// PORT (simplified): vendor/just-bash-rs/src/commands/textutil2.rs
// comm, join, nl, od, fold, expand, unexpand, column, paste, strings, split.
// `rev` from the same Rust file already lives in `text.js` (see there).
// od/strings need byte-level data from a string-backed Vfs, so both go
// through utf8Encode/utf8Decode the same way hash.js does for md5sum/sha256sum.

import { ok, fail, unknownOption } from "./core.js";
import { utf8Encode, utf8Decode } from "../utf8.js";

function linesNoTrailing(content) {
    if (content === "") return [];
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    return lines;
}

function readOperand(interp, file, stdin) {
    if (file === "-") return stdin;
    const path = interp.resolvePath(file);
    if (!interp.vfs.isFile(path)) return undefined;
    return interp.vfs.readFile(path);
}

function parsePosInt(s) {
    return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

// ---------------------------------------------------------------------
// comm
// ---------------------------------------------------------------------

export function commCommand(interp, args, stdin) {
    let suppress1 = false, suppress2 = false, suppress3 = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case "-1": suppress1 = true; break;
            case "-2": suppress2 = true; break;
            case "-3": suppress3 = true; break;
            case "-12": case "-21": suppress1 = true; suppress2 = true; break;
            case "-13": case "-31": suppress1 = true; suppress3 = true; break;
            case "-23": case "-32": suppress2 = true; suppress3 = true; break;
            case "-123": case "-132": case "-213": case "-231": case "-312": case "-321":
                suppress1 = true; suppress2 = true; suppress3 = true; break;
            default:
                if (arg.startsWith("-") && arg !== "-") return unknownOption("comm", arg);
                files.push(arg);
        }
    }
    if (files.length !== 2) return fail("comm: missing operand\nTry 'comm --help' for more information.\n", 1);
    const c1 = readOperand(interp, files[0], stdin);
    if (c1 === undefined) return fail(`comm: ${files[0]}: No such file or directory\n`, 1);
    const c2 = readOperand(interp, files[1], stdin);
    if (c2 === undefined) return fail(`comm: ${files[1]}: No such file or directory\n`, 1);
    const lines1 = linesNoTrailing(c1);
    const lines2 = linesNoTrailing(c2);
    const col2Prefix = suppress1 ? "" : "\t";
    const col3Prefix = (suppress1 ? "" : "\t") + (suppress2 ? "" : "\t");

    let output = "";
    let i = 0, j = 0;
    while (i < lines1.length || j < lines2.length) {
        if (j >= lines2.length || (i < lines1.length && lines1[i] < lines2[j])) {
            if (!suppress1) output += `${lines1[i]}\n`;
            i++;
        } else if (i >= lines1.length || lines1[i] > lines2[j]) {
            if (!suppress2) output += `${col2Prefix}${lines2[j]}\n`;
            j++;
        } else {
            if (!suppress3) output += `${col3Prefix}${lines1[i]}\n`;
            i++; j++;
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// join
// ---------------------------------------------------------------------

function joinSplitLine(line, separator) {
    if (separator !== undefined && separator !== "") return line.split(separator);
    return line.split(/[ \t]+/).filter((s) => s !== "");
}

function joinParseLine(line, separator, joinField, ignoreCase) {
    const fields = joinSplitLine(line, separator);
    let joinKey = fields[joinField - 1] ?? "";
    if (ignoreCase) joinKey = joinKey.toLowerCase();
    return { fields, joinKey };
}

function joinFormatLine(line1, line2, opts) {
    const sep = opts.separator ?? " ";
    if (opts.outputFormat) {
        const parts = opts.outputFormat.map(([file, field]) => {
            const line = file === 1 ? line1 : line2;
            if (field === 0) return line ? line.joinKey : opts.emptyString;
            return line && line.fields[field - 1] !== undefined ? line.fields[field - 1] : opts.emptyString;
        });
        return parts.join(sep);
    }
    const parts = [(line1 ?? line2)?.joinKey ?? ""];
    if (line1) line1.fields.forEach((f, i) => { if (i !== opts.field1 - 1) parts.push(f); });
    if (line2) line2.fields.forEach((f, i) => { if (i !== opts.field2 - 1) parts.push(f); });
    return parts.join(sep);
}

function parseOutputFormat(format) {
    const result = [];
    for (const part of format.split(",")) {
        const trimmed = part.trim();
        const dot = trimmed.indexOf(".");
        if (dot === -1) return null;
        const fileStr = trimmed.slice(0, dot);
        const fieldStr = trimmed.slice(dot + 1);
        if (!/^\d+$/.test(fileStr) || !/^\d+$/.test(fieldStr)) return null;
        const file = parseInt(fileStr, 10);
        if (file !== 1 && file !== 2) return null;
        result.push([file, parseInt(fieldStr, 10)]);
    }
    return result;
}

export function joinCommand(interp, args, stdin) {
    let field1 = 1, field2 = 1;
    let separator;
    const printUnpairable = new Set();
    const onlyUnpairable = new Set();
    let emptyString = "";
    let outputFormat = null;
    let ignoreCase = false;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-1" && i + 1 < args.length) {
            i++;
            const f = parsePosInt(args[i]);
            if (!(f >= 1)) return fail(`join: invalid field number: '${args[i]}'\n`, 1);
            field1 = f;
        } else if (arg === "-2" && i + 1 < args.length) {
            i++;
            const f = parsePosInt(args[i]);
            if (!(f >= 1)) return fail(`join: invalid field number: '${args[i]}'\n`, 1);
            field2 = f;
        } else if ((arg === "-t" || arg === "--field-separator") && i + 1 < args.length) {
            i++;
            separator = args[i];
        } else if (arg.startsWith("-t") && arg.length > 2) {
            separator = arg.slice(2);
        } else if (arg === "-a" && i + 1 < args.length) {
            i++;
            const f = parsePosInt(args[i]);
            if (f !== 1 && f !== 2) return fail(`join: invalid file number: '${args[i]}'\n`, 1);
            printUnpairable.add(f);
        } else if (arg === "-a1") {
            printUnpairable.add(1);
        } else if (arg === "-a2") {
            printUnpairable.add(2);
        } else if (arg === "-v" && i + 1 < args.length) {
            i++;
            const f = parsePosInt(args[i]);
            if (f !== 1 && f !== 2) return fail(`join: invalid file number: '${args[i]}'\n`, 1);
            onlyUnpairable.add(f);
        } else if (arg === "-v1") {
            onlyUnpairable.add(1);
        } else if (arg === "-v2") {
            onlyUnpairable.add(2);
        } else if (arg === "-e" && i + 1 < args.length) {
            i++;
            emptyString = args[i];
        } else if (arg === "-o" && i + 1 < args.length) {
            i++;
            const f = parseOutputFormat(args[i]);
            if (!f) return fail(`join: invalid field spec: '${args[i]}'\n`, 1);
            outputFormat = f;
        } else if (arg === "-i" || arg === "--ignore-case") {
            ignoreCase = true;
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("join", arg);
        } else {
            files.push(arg);
        }
        i++;
    }

    if (files.length !== 2) return fail(files.length < 2 ? "join: missing file operand\n" : "join: extra operand\n", 1);

    const contents = [];
    for (const file of files) {
        const c = readOperand(interp, file, stdin);
        if (c === undefined) return fail(`join: ${file}: No such file or directory\n`, 1);
        contents.push(c);
    }

    const opts = { field1, field2, separator, emptyString, outputFormat };

    const parseLines = (content, joinField) =>
        linesNoTrailing(content).filter((l) => l !== "").map((l) => joinParseLine(l, separator, joinField, ignoreCase));

    const lines1 = parseLines(contents[0], field1);
    const lines2 = parseLines(contents[1], field2);

    const index2 = new Map();
    for (const line of lines2) {
        if (!index2.has(line.joinKey)) index2.set(line.joinKey, []);
        index2.get(line.joinKey).push(line);
    }

    const output = [];
    const matchedKeys2 = new Set();
    for (const line1 of lines1) {
        const matches = index2.get(line1.joinKey);
        if (matches) {
            matchedKeys2.add(line1.joinKey);
            if (onlyUnpairable.size === 0) {
                for (const line2 of matches) output.push(joinFormatLine(line1, line2, opts));
            }
        } else if (printUnpairable.has(1) || onlyUnpairable.has(1)) {
            output.push(joinFormatLine(line1, null, opts));
        }
    }
    if (printUnpairable.has(2) || onlyUnpairable.has(2)) {
        for (const line2 of lines2) {
            if (!matchedKeys2.has(line2.joinKey)) output.push(joinFormatLine(null, line2, opts));
        }
    }

    return ok(output.length ? `${output.join("\n")}\n` : "");
}

// ---------------------------------------------------------------------
// nl
// ---------------------------------------------------------------------

function nlFormatNumber(num, format, width) {
    const s = String(num);
    if (format === "ln") return s.padEnd(width);
    if (format === "rz") return s.padStart(width, "0");
    return s.padStart(width);
}

function nlShouldNumber(line, style) {
    if (style === "a") return true;
    if (style === "n") return false;
    return line.trim() !== "";
}

function nlProcess(content, style, format, width, separator, increment, current) {
    if (content === "") return ["", current];
    const hasTrailing = content.endsWith("\n");
    const lines = linesNoTrailing(content);
    const resultLines = [];
    let n = current;
    for (const line of lines) {
        if (nlShouldNumber(line, style)) {
            resultLines.push(`${nlFormatNumber(n, format, width)}${separator}${line}`);
            n += increment;
        } else {
            resultLines.push(`${" ".repeat(width)}${separator}${line}`);
        }
    }
    let out = resultLines.join("\n");
    if (hasTrailing) out += "\n";
    return [out, n];
}

export function nlCommand(interp, args, stdin) {
    let style = "t";
    let format = "rn";
    let width = 6;
    let separator = "\t";
    let start = 1;
    let increment = 1;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-b" && i + 1 < args.length) {
            i++;
            if (!["a", "t", "n"].includes(args[i])) return fail(`nl: invalid body numbering style: '${args[i]}'\n`, 1);
            style = args[i];
        } else if (arg.startsWith("-b") && arg.length === 3 && ["a", "t", "n"].includes(arg.slice(2))) {
            style = arg.slice(2);
        } else if (arg === "-n" && i + 1 < args.length) {
            i++;
            if (!["ln", "rn", "rz"].includes(args[i])) return fail(`nl: invalid line numbering format: '${args[i]}'\n`, 1);
            format = args[i];
        } else if (arg.startsWith("-n") && arg.length > 2 && ["ln", "rn", "rz"].includes(arg.slice(2))) {
            format = arg.slice(2);
        } else if (arg === "-w" && i + 1 < args.length) {
            i++;
            const w = parsePosInt(args[i]);
            if (!(w >= 1)) return fail(`nl: invalid line number field width: '${args[i]}'\n`, 1);
            width = w;
        } else if (arg.startsWith("-w") && arg.length > 2) {
            const w = parsePosInt(arg.slice(2));
            if (!(w >= 1)) return fail(`nl: invalid line number field width: '${arg.slice(2)}'\n`, 1);
            width = w;
        } else if (arg === "-s" && i + 1 < args.length) {
            i++;
            separator = args[i];
        } else if (arg.startsWith("-s") && arg.length > 2) {
            separator = arg.slice(2);
        } else if (arg === "-v" && i + 1 < args.length) {
            i++;
            if (!/^-?\d+$/.test(args[i])) return fail(`nl: invalid starting line number: '${args[i]}'\n`, 1);
            start = parseInt(args[i], 10);
        } else if (arg.startsWith("-v") && arg.length > 2 && /^-?\d+$/.test(arg.slice(2))) {
            start = parseInt(arg.slice(2), 10);
        } else if (arg === "-i" && i + 1 < args.length) {
            i++;
            if (!/^-?\d+$/.test(args[i])) return fail(`nl: invalid line number increment: '${args[i]}'\n`, 1);
            increment = parseInt(args[i], 10);
        } else if (arg.startsWith("-i") && arg.length > 2 && /^-?\d+$/.test(arg.slice(2))) {
            increment = parseInt(arg.slice(2), 10);
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("nl", arg);
        } else {
            files.push(arg);
        }
        i++;
    }

    let output = "";
    let lineNumber = start;
    if (files.length === 0) {
        [output] = nlProcess(stdin, style, format, width, separator, increment, lineNumber);
    } else {
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `nl: ${file}: No such file or directory\n`, exitCode: 1 };
            const [out, next] = nlProcess(interp.vfs.readFile(path), style, format, width, separator, increment, lineNumber);
            output += out;
            lineNumber = next;
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// od
// ---------------------------------------------------------------------

function odFormatCharByte(code) {
    switch (code) {
        case 0: return "  \\0";
        case 7: return "  \\a";
        case 8: return "  \\b";
        case 9: return "  \\t";
        case 10: return "  \\n";
        case 11: return "  \\v";
        case 12: return "  \\f";
        case 13: return "  \\r";
        default:
            if (code >= 32 && code <= 126) return `   ${String.fromCharCode(code)}`;
            return ` ${code.toString(8).padStart(3, "0")}`;
    }
}

export function odCommand(interp, args, stdin) {
    let addressNone = false;
    const formats = [];
    const fileArgs = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-c") formats.push("char");
        else if (arg === "-An") addressNone = true;
        else if (arg === "-A" && args[i + 1] === "n") { addressNone = true; i++; }
        else if (arg === "-t" && i + 1 < args.length) {
            i++;
            const t = args[i];
            if (t === "x1") formats.push("hex");
            else if (t === "c") formats.push("char");
            else if (t.startsWith("o")) formats.push("octal");
        } else if (!arg.startsWith("-") || arg === "-") {
            fileArgs.push(arg);
        }
        i++;
    }
    if (formats.length === 0) formats.push("octal");

    const operands = fileArgs.length ? fileArgs : ["-"];
    let input = "";
    for (const operand of operands) {
        if (operand === "-") { input += stdin; continue; }
        const path = interp.resolvePath(operand);
        if (!interp.vfs.isFile(path)) return fail(`od: ${operand}: No such file or directory\n`, 1);
        input += interp.vfs.readFile(path);
    }

    const bytes = utf8Encode(input);
    const hasCharFormat = formats.includes("char");
    const bytesPerLine = 16;

    let out = "";
    let offset = 0;
    while (offset < bytes.length) {
        const end = Math.min(offset + bytesPerLine, bytes.length);
        const chunk = bytes.slice(offset, end);
        formats.forEach((format, fi) => {
            let formatted = "";
            for (const b of chunk) {
                if (format === "char") formatted += odFormatCharByte(b);
                else if (format === "hex") formatted += hasCharFormat ? `  ${b.toString(16).padStart(2, "0")}` : ` ${b.toString(16).padStart(2, "0")}`;
                else formatted += ` ${b.toString(8).padStart(3, "0")}`;
            }
            const prefix = addressNone ? "" : fi === 0 ? `${offset.toString(8).padStart(7, "0")} ` : "        ";
            out += `${prefix}${formatted}\n`;
        });
        offset += bytesPerLine;
    }
    if (!addressNone && bytes.length > 0) out += `${bytes.length.toString(8).padStart(7, "0")}\n`;
    return ok(out);
}

// ---------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------

function foldCharWidth(c, currentColumn, countBytes) {
    if (countBytes) return utf8Encode(c).length;
    if (c === "\t") return 8 - (Math.max(currentColumn, 0) % 8);
    if (c === "\b") return -1;
    return 1;
}

function foldLine(line, opts) {
    if (line === "") return "";
    const result = [];
    let current = [];
    let currentColumn = 0;
    let lastSpaceIndex = null;
    let lastSpaceColumn = 0;

    for (const c of line) {
        const w = foldCharWidth(c, currentColumn, opts.countBytes);
        if (currentColumn + w > opts.width && current.length > 0) {
            if (opts.breakAtSpaces && lastSpaceIndex !== null) {
                const head = current.slice(0, lastSpaceIndex + 1).join("");
                const tail = current.slice(lastSpaceIndex + 1);
                result.push(head);
                current = tail;
                current.push(c);
                currentColumn = currentColumn - lastSpaceColumn - 1 + w;
            } else {
                result.push(current.join(""));
                current = [c];
                currentColumn = w;
            }
            lastSpaceIndex = null;
            lastSpaceColumn = 0;
        } else {
            current.push(c);
            currentColumn += w;
            if (c === " " || c === "\t") {
                lastSpaceIndex = current.length - 1;
                lastSpaceColumn = currentColumn - w;
            }
        }
    }
    if (current.length > 0) result.push(current.join(""));
    return result.join("\n");
}

function foldProcess(content, opts) {
    if (content === "") return "";
    const hasTrailing = content.endsWith("\n");
    let out = linesNoTrailing(content).map((l) => foldLine(l, opts)).join("\n");
    if (hasTrailing) out += "\n";
    return out;
}

// Recognizes `-[sb]+w[DIGITS]` (`-sw40`, `-bsw`, `-sw`): combined -s/-b
// short flags immediately followed by -w's width, attached or not.
function foldSbWBody(arg) {
    if (!arg.startsWith("-")) return null;
    const body = arg.slice(1);
    const wIdx = body.indexOf("w");
    if (wIdx === -1) return null;
    const flags = body.slice(0, wIdx);
    const digits = body.slice(wIdx + 1);
    if (flags.length === 0 || ![...flags].every((c) => c === "s" || c === "b")) return null;
    if (![...digits].every((c) => c >= "0" && c <= "9")) return null;
    return [flags, digits];
}

export function foldCommand(interp, args, stdin) {
    const opts = { width: 80, breakAtSpaces: false, countBytes: false };
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-w" && i + 1 < args.length) {
            i++;
            const w = parsePosInt(args[i]);
            if (!(w >= 1)) return fail(`fold: invalid number of columns: '${args[i]}'\n`, 1);
            opts.width = w;
        } else if (arg.startsWith("-w") && arg.length > 2) {
            const w = parsePosInt(arg.slice(2));
            if (!(w >= 1)) return fail(`fold: invalid number of columns: '${arg.slice(2)}'\n`, 1);
            opts.width = w;
        } else if (arg === "-s") {
            opts.breakAtSpaces = true;
        } else if (arg === "-b") {
            opts.countBytes = true;
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else {
            const sbw = foldSbWBody(arg);
            if (sbw) {
                const [flags, widthDigits] = sbw;
                if (flags.includes("s")) opts.breakAtSpaces = true;
                if (flags.includes("b")) opts.countBytes = true;
                let widthStr = widthDigits;
                if (widthDigits === "") {
                    if (i + 1 >= args.length) return unknownOption("fold", arg);
                    i++;
                    widthStr = args[i];
                }
                const w = parsePosInt(widthStr);
                if (!(w >= 1)) return fail(`fold: invalid number of columns: '${widthStr}'\n`, 1);
                opts.width = w;
            } else if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
                for (const c of arg.slice(1)) {
                    if (c === "s") opts.breakAtSpaces = true;
                    else if (c === "b") opts.countBytes = true;
                    else return unknownOption("fold", arg);
                }
            } else {
                files.push(arg);
            }
        }
        i++;
    }

    let output = "";
    if (files.length === 0) {
        output = foldProcess(stdin, opts);
    } else {
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `fold: ${file}: No such file or directory\n`, exitCode: 1 };
            output += foldProcess(interp.vfs.readFile(path), opts);
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// expand / unexpand
// ---------------------------------------------------------------------

function parseTabStops(spec) {
    const stops = [];
    for (const part of spec.split(",")) {
        const trimmed = part.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const n = parseInt(trimmed, 10);
        if (n < 1) return null;
        stops.push(n);
    }
    for (let i = 1; i < stops.length; i++) {
        if (stops[i] <= stops[i - 1]) return null;
    }
    return stops.length ? stops : null;
}

function tabWidthAt(column, stops) {
    if (stops.length === 1) {
        const w = stops[0];
        return w - (column % w);
    }
    for (const s of stops) if (s > column) return s - column;
    const lastInterval = stops[stops.length - 1] - stops[stops.length - 2];
    const lastStop = stops[stops.length - 1];
    const stopsAfter = Math.floor((column - lastStop) / lastInterval) + 1;
    return lastStop + stopsAfter * lastInterval - column;
}

function nextTabStop(column, stops) {
    if (stops.length === 1) {
        const w = stops[0];
        return column + (w - (column % w));
    }
    for (const s of stops) if (s > column) return s;
    const lastInterval = stops[stops.length - 1] - stops[stops.length - 2];
    const lastStop = stops[stops.length - 1];
    const stopsAfter = Math.floor((column - lastStop) / lastInterval) + 1;
    return lastStop + stopsAfter * lastInterval;
}

function expandLine(line, stops, leadingOnly) {
    let result = "";
    let column = 0;
    let inLeading = true;
    for (const c of line) {
        if (c === "\t") {
            if (leadingOnly && !inLeading) {
                result += c;
                column += 1;
            } else {
                const spaces = tabWidthAt(column, stops);
                result += " ".repeat(spaces);
                column += spaces;
            }
        } else {
            if (c !== " ") inLeading = false;
            result += c;
            column += 1;
        }
    }
    return result;
}

function expandProcess(content, stops, leadingOnly) {
    if (content === "") return "";
    const hasTrailing = content.endsWith("\n");
    let out = linesNoTrailing(content).map((l) => expandLine(l, stops, leadingOnly)).join("\n");
    if (hasTrailing) out += "\n";
    return out;
}

function isTabFlag(arg) {
    return arg === "-t" || (arg.startsWith("-t") && arg.length > 2) || arg === "--tabs" || arg.startsWith("--tabs=");
}

// Shared -t/--tabs tab-stop-spec parsing for expand/unexpand. Returns
// { tabStops, consumed } on success (consumed = extra args to skip past)
// or { error } on invalid syntax.
function parseTabStopFlags(cmd, args, i) {
    const arg = args[i];
    const apply = (spec, consumed) => {
        const s = parseTabStops(spec);
        return s === null ? { error: fail(`${cmd}: invalid tab size: '${spec}'\n`, 1) } : { tabStops: s, consumed };
    };
    if (arg === "-t" && i + 1 < args.length) return apply(args[i + 1], 1);
    if (arg.startsWith("-t") && arg.length > 2) return apply(arg.slice(2), 0);
    if (arg === "--tabs" && i + 1 < args.length) return apply(args[i + 1], 1);
    if (arg.startsWith("--tabs=")) return apply(arg.slice("--tabs=".length), 0);
    return { error: fail(`${cmd}: unrecognized argument\n`, 1) };
}

export function expandCommand(interp, args, stdin) {
    let tabStops = [8];
    let leadingOnly = false;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (isTabFlag(arg)) {
            const r = parseTabStopFlags("expand", args, i);
            if (r.error) return r.error;
            tabStops = r.tabStops;
            i += r.consumed;
        } else if (arg === "-i" || arg === "--initial") {
            leadingOnly = true;
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("expand", arg);
        } else {
            files.push(arg);
        }
        i++;
    }

    let output = "";
    if (files.length === 0) {
        output = expandProcess(stdin, tabStops, leadingOnly);
    } else {
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `expand: ${file}: No such file or directory\n`, exitCode: 1 };
            output += expandProcess(interp.vfs.readFile(path), tabStops, leadingOnly);
        }
    }
    return ok(output);
}

function unexpandLine(line, stops, allBlanks) {
    let result = "";
    let column = 0;
    let spaceRun = "";
    let spaceRunStart = 0;
    let inLeading = true;

    const flush = () => {
        if (spaceRun === "") return;
        const endColumn = spaceRunStart + spaceRun.length;
        if (!allBlanks && !inLeading) {
            result += spaceRun;
            spaceRun = "";
            return;
        }
        let currentPos = spaceRunStart;
        let converted = "";
        for (;;) {
            const nextStop = nextTabStop(currentPos, stops);
            if (nextStop <= endColumn && nextStop > currentPos) {
                converted += "\t";
                currentPos = nextStop;
            } else {
                break;
            }
        }
        const remaining = endColumn - currentPos;
        if (remaining > 0) converted += " ".repeat(remaining);
        result += converted;
        spaceRun = "";
    };

    for (const c of line) {
        if (c === " ") {
            if (spaceRun === "") spaceRunStart = column;
            spaceRun += c;
            column += 1;
        } else if (c === "\t") {
            flush();
            result += c;
            column = nextTabStop(column, stops);
        } else {
            flush();
            result += c;
            column += 1;
            inLeading = false;
        }
    }
    flush();
    return result;
}

function unexpandProcess(content, stops, allBlanks) {
    if (content === "") return "";
    const hasTrailing = content.endsWith("\n");
    let out = linesNoTrailing(content).map((l) => unexpandLine(l, stops, allBlanks)).join("\n");
    if (hasTrailing) out += "\n";
    return out;
}

export function unexpandCommand(interp, args, stdin) {
    let tabStops = [8];
    let allBlanks = false;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (isTabFlag(arg)) {
            const r = parseTabStopFlags("unexpand", args, i);
            if (r.error) return r.error;
            tabStops = r.tabStops;
            i += r.consumed;
        } else if (arg === "-a" || arg === "--all") {
            allBlanks = true;
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("unexpand", arg);
        } else {
            files.push(arg);
        }
        i++;
    }

    let output = "";
    if (files.length === 0) {
        output = unexpandProcess(stdin, tabStops, allBlanks);
    } else {
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `unexpand: ${file}: No such file or directory\n`, exitCode: 1 };
            output += unexpandProcess(interp.vfs.readFile(path), tabStops, allBlanks);
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// column
// ---------------------------------------------------------------------

function readConcat(interp, files, cmdName, stdin) {
    if (files.length === 0) return { content: stdin };
    let content = "";
    for (const f of files) {
        if (f === "-") { content += stdin; continue; }
        const path = interp.resolvePath(f);
        if (!interp.vfs.isFile(path)) return { error: fail(`${cmdName}: ${f}: No such file or directory\n`, 1) };
        content += interp.vfs.readFile(path);
    }
    return { content };
}

function columnSplitFields(line, separator, noMerge) {
    if (separator !== undefined && separator !== "") {
        const parts = line.split(separator);
        return noMerge ? parts : parts.filter((f) => f !== "");
    }
    if (noMerge) return line.split(/[ \t]/);
    return line.split(/[ \t]+/).filter((s) => s !== "");
}

function columnWidths(rows) {
    const widths = [];
    for (const row of rows) {
        row.forEach((cell, i) => {
            const w = [...cell].length;
            if (i >= widths.length) widths.push(w);
            else if (w > widths[i]) widths[i] = w;
        });
    }
    return widths;
}

function columnFormatTable(rows, outSep) {
    if (rows.length === 0) return "";
    const widths = columnWidths(rows);
    let out = "";
    rows.forEach((row, ri) => {
        if (ri > 0) out += "\n";
        row.forEach((cell, i) => {
            if (i > 0) out += outSep;
            out += cell;
            if (i < row.length - 1) out += " ".repeat(Math.max(0, widths[i] - [...cell].length));
        });
    });
    return out;
}

function columnFormatFill(items, width, outSep) {
    if (items.length === 0) return "";
    const maxItemWidth = Math.max(...items.map((it) => [...it].length));
    const sepWidth = [...outSep].length;
    const columnWidth = Math.max(maxItemWidth + sepWidth, 1);
    const numColumns = Math.max(Math.floor((Math.max(width, 0) + sepWidth) / columnWidth), 1);
    const numRows = Math.ceil(items.length / numColumns);

    let out = "";
    for (let row = 0; row < numRows; row++) {
        if (row > 0) out += "\n";
        let emitted = false;
        for (let col = 0; col < numColumns; col++) {
            const index = col * numRows + row;
            if (index < items.length) {
                const isLastInRow = col === numColumns - 1 || (col + 1) * numRows + row >= items.length;
                if (emitted) out += outSep;
                out += items[index];
                if (!isLastInRow) out += " ".repeat(Math.max(0, maxItemWidth - [...items[index]].length));
                emitted = true;
            }
        }
    }
    return out;
}

export function columnCommand(interp, args, stdin) {
    let table = false;
    let separator;
    let outputSep;
    let width = 80;
    let noMerge = false;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-t") table = true;
        else if (arg === "-s" && i + 1 < args.length) { i++; separator = args[i]; }
        else if (arg === "-o" && i + 1 < args.length) { i++; outputSep = args[i]; }
        else if (arg === "-c" && i + 1 < args.length) {
            i++;
            if (!/^-?\d+$/.test(args[i])) return fail(`column: invalid width: ${args[i]}\n`, 1);
            width = parseInt(args[i], 10);
        } else if (arg === "-n") {
            noMerge = true;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("column", arg);
        } else {
            files.push(arg);
        }
        i++;
    }
    if (width <= 0) return fail(`column: invalid width: ${width}\n`, 1);
    const outSep = outputSep ?? "  ";

    const rc = readConcat(interp, files, "column", stdin);
    if (rc.error) return rc.error;
    if (rc.content.trim() === "") return ok("");

    const nonEmpty = linesNoTrailing(rc.content).filter((l) => l.trim() !== "");

    let output;
    if (table) {
        const rows = nonEmpty.map((l) => columnSplitFields(l, separator, noMerge));
        output = columnFormatTable(rows, outSep);
    } else {
        const items = nonEmpty.flatMap((l) => columnSplitFields(l, separator, noMerge));
        output = columnFormatFill(items, width, outSep);
    }
    if (output !== "") output += "\n";
    return ok(output);
}

// ---------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------

function joinWithDelimiters(parts, delimiters) {
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    if (delimiters === "") return parts.join("");
    const delimChars = [...delimiters];
    let result = parts[0];
    for (let i = 1; i < parts.length; i++) {
        result += delimChars[(i - 1) % delimChars.length];
        result += parts[i];
    }
    return result;
}

export function pasteCommand(interp, args, stdin) {
    let delimiter = "\t";
    let serial = false;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if ((arg === "-d" || arg === "--delimiters") && i + 1 < args.length) {
            i++;
            delimiter = args[i];
        } else if (arg.startsWith("-d") && arg.length > 2) {
            delimiter = arg.slice(2);
        } else if (arg === "-s" || arg === "--serial") {
            serial = true;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("paste", arg);
        } else {
            files.push(arg);
        }
        i++;
    }
    if (files.length === 0) return fail("usage: paste [-s] [-d delimiters] file ...\n", 1);

    const stdinLines = linesNoTrailing(stdin);
    const stdinCount = files.filter((f) => f === "-").length;

    const fileContents = [];
    let stdinIndex = 0;
    for (const file of files) {
        if (file === "-") {
            const thisStdin = [];
            for (let idx = stdinIndex; idx < stdinLines.length; idx += stdinCount) thisStdin.push(stdinLines[idx]);
            fileContents.push(thisStdin);
            stdinIndex += 1;
        } else {
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return fail(`paste: ${file}: No such file or directory\n`, 1);
            fileContents.push(linesNoTrailing(interp.vfs.readFile(path)));
        }
    }

    let output = "";
    if (serial) {
        for (const lines of fileContents) output += `${joinWithDelimiters(lines, delimiter)}\n`;
    } else {
        const maxLines = Math.max(0, ...fileContents.map((l) => l.length));
        for (let idx = 0; idx < maxLines; idx++) {
            const parts = fileContents.map((lines) => lines[idx] ?? "");
            output += `${joinWithDelimiters(parts, delimiter)}\n`;
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// strings
// ---------------------------------------------------------------------

function isPrintableByte(b) {
    return (b >= 32 && b <= 126) || b === 9;
}

function formatStringsOffset(offset, format) {
    if (format === "o") return `${offset.toString(8).padStart(7)} `;
    if (format === "x") return `${offset.toString(16).padStart(7)} `;
    if (format === "d") return `${String(offset).padStart(7)} `;
    return "";
}

function extractStrings(bytes, minLength, offsetFormat) {
    const results = [];
    let currentLength = 0;
    let stringStart = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (isPrintableByte(bytes[i])) {
            if (currentLength === 0) stringStart = i;
            currentLength += 1;
        } else {
            if (currentLength >= minLength) results.push(formatStringsOffset(stringStart, offsetFormat) + utf8Decode(bytes.slice(stringStart, i)));
            currentLength = 0;
        }
    }
    if (currentLength >= minLength) results.push(formatStringsOffset(stringStart, offsetFormat) + utf8Decode(bytes.slice(stringStart)));
    return results;
}

export function stringsCommand(interp, args, stdin) {
    let minLength = 4;
    let offsetFormat = null;
    const files = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-n" && i + 1 < args.length) {
            i++;
            const n = parsePosInt(args[i]);
            if (!(n >= 1)) return fail(`strings: invalid minimum string length: '${args[i]}'\n`, 1);
            minLength = n;
        } else if (arg.startsWith("-n") && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
            minLength = parseInt(arg.slice(2), 10);
        } else if (arg.length > 1 && arg.startsWith("-") && /^\d+$/.test(arg.slice(1))) {
            minLength = parseInt(arg.slice(1), 10);
        } else if (arg === "-t" && i + 1 < args.length) {
            i++;
            if (!["o", "x", "d"].includes(args[i])) return fail(`strings: invalid radix: '${args[i]}'\n`, 1);
            offsetFormat = args[i];
        } else if (arg === "-a" || arg === "--all") {
            // recognized, no-op (this port always scans the whole input)
        } else if (arg === "-e" && i + 1 < args.length) {
            i++;
            if (args[i] !== "s" && args[i] !== "S") return fail(`strings: invalid encoding: '${args[i]}'\n`, 1);
        } else if (arg === "--") {
            files.push(...args.slice(i + 1));
            break;
        } else if (arg === "-") {
            files.push("-");
        } else if (arg.startsWith("-") && arg.length > 1) {
            return unknownOption("strings", arg);
        } else {
            files.push(arg);
        }
        i++;
    }

    let output = "";
    if (files.length === 0) {
        const found = extractStrings(utf8Encode(stdin), minLength, offsetFormat);
        if (found.length) output = `${found.join("\n")}\n`;
    } else {
        for (const file of files) {
            let bytes;
            if (file === "-") {
                bytes = utf8Encode(stdin);
            } else {
                const path = interp.resolvePath(file);
                if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `strings: ${file}: No such file or directory\n`, exitCode: 1 };
                bytes = utf8Encode(interp.vfs.readFile(path));
            }
            const found = extractStrings(bytes, minLength, offsetFormat);
            if (found.length) output += `${found.join("\n")}\n`;
        }
    }
    return ok(output);
}

// ---------------------------------------------------------------------
// split
// ---------------------------------------------------------------------
//
// Simplified like the Rust port: upstream's split.ts stages every output
// file under a temp name and rolls the batch back on failure, guarding
// against real filesystem aliasing/rename races. This Vfs is in-memory,
// single-threaded, with no aliasing, so this port writes each file directly.

function parseSplitSize(spec) {
    let splitAt = spec.length;
    for (let i = 0; i < spec.length; i++) {
        if (!/[0-9]/.test(spec[i])) { splitAt = i; break; }
    }
    const numPart = spec.slice(0, splitAt);
    if (numPart === "") return null;
    const suffix = spec.slice(splitAt).replace(/[bB]+$/, "").toUpperCase();
    const mults = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
    if (!(suffix in mults)) return null;
    return parseInt(numPart, 10) * mults[suffix];
}

function generateSplitSuffix(index, numeric, length) {
    if (numeric) return String(index).padStart(length, "0");
    const chars = "abcdefghijklmnopqrstuvwxyz";
    const suffix = new Array(length).fill("a");
    let remaining = index;
    for (let slot = length - 1; slot >= 0; slot--) {
        suffix[slot] = chars[remaining % 26];
        remaining = Math.floor(remaining / 26);
    }
    return suffix.join("");
}

function splitByLines(bytes, linesPerFile) {
    const chunks = [];
    let start = 0;
    let lines = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        lines += 1;
        if (lines === linesPerFile) {
            chunks.push(bytes.slice(start, i + 1));
            start = i + 1;
            lines = 0;
        }
    }
    if (start < bytes.length) chunks.push(bytes.slice(start));
    return chunks;
}

function splitBytesFixed(bytes, size) {
    const chunks = [];
    const step = Math.max(size, 1);
    for (let i = 0; i < bytes.length; i += step) chunks.push(bytes.slice(i, i + step));
    return chunks;
}

function splitIntoChunks(bytes, numChunks) {
    const chunks = [];
    const bytesPerChunk = Math.ceil(bytes.length / Math.max(numChunks, 1));
    for (let i = 0; i < numChunks; i++) {
        const start = i * bytesPerChunk;
        const end = Math.min(start + bytesPerChunk, bytes.length);
        if (start < end) chunks.push(bytes.slice(start, end));
    }
    return chunks;
}

export function splitCommand(interp, args, stdin) {
    let mode = { kind: "lines", n: 1000 };
    let numericSuffix = false;
    let suffixLength = 2;
    let additionalSuffix = "";
    const positional = [];
    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-l" && i + 1 < args.length) {
            i++;
            const n = parsePosInt(args[i]);
            if (!(n >= 1)) return fail(`split: invalid number of lines: '${args[i]}'\n`, 1);
            mode = { kind: "lines", n };
        } else if (arg.startsWith("-l") && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
            mode = { kind: "lines", n: parseInt(arg.slice(2), 10) };
        } else if (arg === "-b" && i + 1 < args.length) {
            i++;
            const n = parseSplitSize(args[i]);
            if (n === null) return fail(`split: invalid number of bytes: '${args[i]}'\n`, 1);
            mode = { kind: "bytes", n };
        } else if (arg.startsWith("-b") && arg.length > 2) {
            const n = parseSplitSize(arg.slice(2));
            if (n === null) return fail(`split: invalid number of bytes: '${arg.slice(2)}'\n`, 1);
            mode = { kind: "bytes", n };
        } else if (arg === "-n" && i + 1 < args.length) {
            i++;
            const n = parsePosInt(args[i]);
            if (!(n >= 1)) return fail(`split: invalid number of chunks: '${args[i]}'\n`, 1);
            mode = { kind: "chunks", n };
        } else if (arg.startsWith("-n") && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
            mode = { kind: "chunks", n: parseInt(arg.slice(2), 10) };
        } else if (arg === "-a" && i + 1 < args.length) {
            i++;
            const n = parsePosInt(args[i]);
            if (!(n >= 1)) return fail(`split: invalid suffix length: '${args[i]}'\n`, 1);
            suffixLength = n;
        } else if (arg.startsWith("-a") && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
            suffixLength = parseInt(arg.slice(2), 10);
        } else if (arg === "-d" || arg === "--numeric-suffixes") {
            numericSuffix = true;
        } else if (arg.startsWith("--additional-suffix=")) {
            additionalSuffix = arg.slice("--additional-suffix=".length);
        } else if (arg === "--additional-suffix" && i + 1 < args.length) {
            i++;
            additionalSuffix = args[i];
        } else if (arg === "--") {
            positional.push(...args.slice(i + 1));
            break;
        } else if (arg.startsWith("-") && arg !== "-") {
            return unknownOption("split", arg);
        } else {
            positional.push(arg);
        }
        i++;
    }

    if (positional.length > 2) return fail(`split: extra operand '${positional[2]}'\n`, 1);
    const inputFile = positional[0] ?? "-";
    const prefix = positional[1] ?? "x";

    let content;
    if (inputFile === "-") {
        content = utf8Encode(stdin);
    } else {
        const path = interp.resolvePath(inputFile);
        if (!interp.vfs.isFile(path)) return fail(`split: ${inputFile}: No such file or directory\n`, 1);
        content = utf8Encode(interp.vfs.readFile(path));
    }
    if (content.length === 0) return ok("");

    let chunks;
    if (mode.kind === "lines") chunks = splitByLines(content, mode.n);
    else if (mode.kind === "bytes") chunks = splitBytesFixed(content, mode.n);
    else chunks = splitIntoChunks(content, mode.n);

    for (let idx = 0; idx < chunks.length; idx++) {
        const filename = `${prefix}${generateSplitSuffix(idx, numericSuffix, suffixLength)}${additionalSuffix}`;
        const path = interp.resolvePath(filename);
        try {
            interp.vfs.writeFile(path, utf8Decode(chunks[idx]));
        } catch {
            return fail("split: failed to write output\n", 1);
        }
    }
    return ok("");
}
