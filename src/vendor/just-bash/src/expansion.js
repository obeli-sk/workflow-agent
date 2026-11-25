// Word expansion: parameter/variable substitution, command substitution,
// arithmetic expansion, field splitting on IFS whitespace, and pathname
// (glob) expansion of unquoted literal text. `ctx` is supplied by the
// interpreter: { getVar, setVar, runCommandSub, evalArith, vfs, cwd }.

import { braceExpand } from "./brace.js";
import { globToRegExp, hasGlobChars, globPaths } from "./glob.js";

export class ShellExpansionError extends Error {}

function fragmentsOf(part, ctx) {
    switch (part.type) {
        case "literal":
            return [{ text: part.text, splittable: true, glob: true }];
        case "quoted":
            return [{ text: part.text, splittable: false, glob: false }];
        case "var":
            return [{ text: expandVar(part, ctx), splittable: !part.quoted, glob: false }];
        case "cmdsub":
            return [{ text: ctx.runCommandSub(part.script), splittable: !part.quoted, glob: false }];
        case "arith":
            return [{ text: ctx.evalArith(part.expr), splittable: !part.quoted, glob: false }];
        case "procsub":
            return [{ text: ctx.procSub(part.script, part.write), splittable: !part.quoted, glob: false }];
        default:
            return [{ text: "", splittable: true, glob: true }];
    }
}

function wordFragments(word, ctx) {
    const frags = [];
    for (const part of word) frags.push(...fragmentsOf(part, ctx));
    return frags;
}

// Concatenate all fragments with no field splitting or globbing (assignment
// RHS, redirect targets, case subject/patterns).
export function expandWordSingle(word, ctx) {
    return wordFragments(word, ctx).map((f) => f.text).join("");
}

// Full expansion to zero or more fields, applying IFS splitting to unquoted
// content and glob expansion to fields containing unquoted metacharacters.
export function expandWordToFields(word, ctx) {
    const fields = [];
    let current = null;
    let currentHasGlob = false;
    const anchor = () => { if (current === null) current = ""; };
    const flush = () => {
        if (current !== null) {
            fields.push(currentHasGlob ? expandGlobField(current, ctx) : [current]);
        }
        current = null;
        currentHasGlob = false;
    };
    for (const frag of wordFragments(word, ctx)) {
        if (!frag.splittable) {
            anchor();
            current += frag.text;
            if (frag.glob && hasGlobChars(frag.text)) currentHasGlob = true;
            continue;
        }
        if (frag.text === "") continue;
        const segments = frag.text.split(/[ \t\n]+/);
        for (let i = 0; i < segments.length; i++) {
            if (i > 0) flush();
            if (segments[i] !== "") {
                anchor();
                current += segments[i];
                if (frag.glob && hasGlobChars(segments[i])) currentHasGlob = true;
            }
        }
    }
    flush();
    return fields.flat();
}

function expandGlobField(pattern, ctx) {
    const matches = globPaths(ctx.vfs, pattern, ctx.cwd);
    return matches.length ? matches : [pattern];
}

const POSITIONAL_RE = /^[0-9]+$/;

function expandVar(part, ctx) {
    const raw = readVar(part.name, ctx);
    if (!part.op) return raw ?? "";
    const isUnset = raw === undefined;
    const isEmpty = isUnset || raw === "";
    switch (part.op) {
        case "len":
            if (part.name === "@" || part.name === "*") return String(ctx.positional().length);
            return String((raw ?? "").length);
        case "-":
            return isUnset ? expandWordSingle(part.arg, ctx) : raw;
        case ":-":
            return isEmpty ? expandWordSingle(part.arg, ctx) : raw;
        case "=":
            if (isUnset) { const v = expandWordSingle(part.arg, ctx); ctx.setVar(part.name, v); return v; }
            return raw;
        case ":=":
            if (isEmpty) { const v = expandWordSingle(part.arg, ctx); ctx.setVar(part.name, v); return v; }
            return raw;
        case "+":
            return isUnset ? "" : expandWordSingle(part.arg, ctx);
        case ":+":
            return isEmpty ? "" : expandWordSingle(part.arg, ctx);
        case "?":
            if (isUnset) throw new ShellExpansionError(`${part.name}: ${errArg(part, ctx, "parameter not set")}`);
            return raw;
        case ":?":
            if (isEmpty) throw new ShellExpansionError(`${part.name}: ${errArg(part, ctx, "parameter null or not set")}`);
            return raw;
        case "#":
            return trimPrefix(raw ?? "", part.arg, ctx, false);
        case "##":
            return trimPrefix(raw ?? "", part.arg, ctx, true);
        case "%":
            return trimSuffix(raw ?? "", part.arg, ctx, false);
        case "%%":
            return trimSuffix(raw ?? "", part.arg, ctx, true);
        default:
            return raw ?? "";
    }
}

function errArg(part, ctx, fallback) {
    const text = expandWordSingle(part.arg, ctx);
    return text || fallback;
}

function readVar(name, ctx) {
    if (name === "@" || name === "*") return ctx.positional().join(" ");
    if (POSITIONAL_RE.test(name)) {
        const idx = parseInt(name, 10);
        if (idx === 0) return ctx.getVar("0");
        return ctx.positional()[idx - 1];
    }
    return ctx.getVar(name);
}

function trimPrefix(value, argWord, ctx, longest) {
    const pattern = expandWordSingle(argWord, ctx);
    if (!pattern) return value;
    const re = globToRegExp(pattern);
    const candidates = longest
        ? range(value.length, -1, -1)
        : range(1, value.length + 1, 1);
    for (const len of candidates) {
        const prefix = value.slice(0, len);
        if (re.test(prefix)) return value.slice(len);
    }
    if (re.test("")) return value;
    return value;
}

function trimSuffix(value, argWord, ctx, longest) {
    const pattern = expandWordSingle(argWord, ctx);
    if (!pattern) return value;
    const re = globToRegExp(pattern);
    const candidates = longest
        ? range(0, value.length, 1)
        : range(value.length, -1, -1);
    for (const start of candidates) {
        const suffix = value.slice(start);
        if (re.test(suffix)) return value.slice(0, start);
    }
    return value;
}

function range(from, to, step) {
    const out = [];
    if (step > 0) for (let i = from; i < to; i += step) out.push(i);
    else for (let i = from; i > to; i += step) out.push(i);
    return out;
}

// Applied to `for name in words...` item lists and case items: brace
// expansion runs on the raw literal text before variable/glob expansion, so
// it only affects unquoted `{a,b}`/`{1..5}` written directly in the source.
export function braceExpandWord(word) {
    if (word.length === 1 && word[0].type === "literal") {
        return braceExpand(word[0].text).map((text) => [{ type: "literal", text }]);
    }
    return [word];
}
