//! Brace expansion: `{a,b,c}` comma lists and `{x..y[..incr]}` sequence
//! expressions. In bash this is the very first expansion, done purely
//! textually before parameter expansion, so `{0..3}` expands but `$x` holding
//! `{0..3}` does not. It runs on the parsed `Word` (a list of parts) rather
//! than raw source: only unquoted `Literal` text can carry the brace
//! metacharacters `{ } , ..`; every other part (a quoted literal, variable,
//! command substitution, or arithmetic expansion) is opaque and is carried
//! through each expansion verbatim.
//!
//! A word is turned into a flat token stream of literal chars and opaque
//! parts, the standard recursive brace algorithm runs over it (find the first
//! `{`, its matching `}`, split the amble into options, cartesian-multiply
//! with the recursively-expanded remainder), and each result is reassembled
//! back into a `Word`. A brace group with neither a top-level comma nor a
//! valid sequence is left literal, matching bash (`{}`, `{abc}`, `a{b`).

use crate::ast::{Word, WordPart};

#[derive(Clone)]
enum Tok {
    /// A raw character from unquoted literal text, eligible to form brace
    /// syntax.
    Ch(char),
    /// A non-literal word part carried through verbatim; never brace syntax.
    Opaque(WordPart),
}

/// Expand a single word into one or more words. A word with no unquoted `{`
/// yields exactly itself.
pub fn expand(word: &Word) -> Vec<Word> {
    let toks = tokenize(word);
    if !toks.iter().any(|t| matches!(t, Tok::Ch('{'))) {
        return vec![word.clone()];
    }
    expand_toks(&toks).iter().map(|t| to_word(t)).collect()
}

fn tokenize(word: &Word) -> Vec<Tok> {
    let mut toks = Vec::new();
    for part in word {
        match part {
            WordPart::Literal(s) => toks.extend(s.chars().map(Tok::Ch)),
            other => toks.push(Tok::Opaque(other.clone())),
        }
    }
    toks
}

fn to_word(toks: &[Tok]) -> Word {
    let mut word: Word = Vec::new();
    let mut lit = String::new();
    for t in toks {
        match t {
            Tok::Ch(c) => lit.push(*c),
            Tok::Opaque(p) => {
                if !lit.is_empty() {
                    word.push(WordPart::Literal(std::mem::take(&mut lit)));
                }
                word.push(p.clone());
            }
        }
    }
    if !lit.is_empty() {
        word.push(WordPart::Literal(lit));
    }
    word
}

fn expand_toks(toks: &[Tok]) -> Vec<Vec<Tok>> {
    let Some(open) = toks.iter().position(|t| matches!(t, Tok::Ch('{'))) else {
        return vec![toks.to_vec()];
    };
    let Some(close) = matching_close(toks, open) else {
        return vec![toks.to_vec()];
    };

    let Some(options) = split_options(&toks[open + 1..close]) else {
        // Not a valid brace group: keep the `{` literal and recurse on the
        // remainder so a later valid group still expands (`{a}{b,c}`).
        let prefix = &toks[..=open];
        return expand_toks(&toks[open + 1..])
            .into_iter()
            .map(|rest| [prefix, &rest].concat())
            .collect();
    };

    let pre = &toks[..open];
    let post_expanded = expand_toks(&toks[close + 1..]);
    let mut results = Vec::new();
    for opt in &options {
        for opt_exp in expand_toks(opt) {
            for post_exp in &post_expanded {
                results.push([pre, &opt_exp, post_exp].concat());
            }
        }
    }
    results
}

fn matching_close(toks: &[Tok], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (k, t) in toks.iter().enumerate().skip(open) {
        match t {
            Tok::Ch('{') => depth += 1,
            Tok::Ch('}') => {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
            }
            _ => {}
        }
    }
    None
}

/// Split a brace amble into its options: a top-level comma list if there is at
/// least one comma, else a numeric or single-character sequence, else `None`
/// (the braces are literal).
fn split_options(amble: &[Tok]) -> Option<Vec<Vec<Tok>>> {
    let parts = split_top_level_commas(amble);
    if parts.len() >= 2 {
        return Some(parts);
    }
    expand_sequence(amble)
}

fn split_top_level_commas(amble: &[Tok]) -> Vec<Vec<Tok>> {
    let mut parts = vec![Vec::new()];
    let mut depth = 0i32;
    for t in amble {
        match t {
            Tok::Ch('{') => {
                depth += 1;
                parts.last_mut().unwrap().push(t.clone());
            }
            Tok::Ch('}') => {
                depth -= 1;
                parts.last_mut().unwrap().push(t.clone());
            }
            Tok::Ch(',') if depth == 0 => parts.push(Vec::new()),
            _ => parts.last_mut().unwrap().push(t.clone()),
        }
    }
    parts
}

fn expand_sequence(amble: &[Tok]) -> Option<Vec<Vec<Tok>>> {
    let s = amble_str(amble)?;
    let segs: Vec<&str> = s.split("..").collect();
    if segs.len() != 2 && segs.len() != 3 {
        return None;
    }
    let (start, end) = (segs[0], segs[1]);
    let incr = segs.get(2).copied();

    if let (Some(a), Some(b)) = (parse_int(start), parse_int(end)) {
        let step = seq_step(incr)?;
        let width = seq_width(start, end);
        let mut out = Vec::new();
        let mut v = a;
        while (a <= b && v <= b) || (a > b && v >= b) {
            out.push(str_to_toks(&fmt_num(v, width)));
            v = if a <= b { v + step } else { v - step };
        }
        return Some(out);
    }

    if let (Some(a), Some(b)) = (single_char(start), single_char(end)) {
        let step = seq_step(incr)?;
        let (a, b) = (a as i64, b as i64);
        let mut out = Vec::new();
        let mut v = a;
        while (a <= b && v <= b) || (a > b && v >= b) {
            if let Some(c) = char::from_u32(v as u32) {
                out.push(str_to_toks(&c.to_string()));
            }
            v = if a <= b { v + step } else { v - step };
        }
        return Some(out);
    }

    None
}

/// The absolute increment for a sequence (`..incr`), defaulting to 1. A zero or
/// non-integer increment makes the whole expression invalid.
fn seq_step(incr: Option<&str>) -> Option<i64> {
    match incr {
        None => Some(1),
        Some(i) => {
            let n: i64 = i.parse().ok()?;
            if n == 0 { None } else { Some(n.abs()) }
        }
    }
}

fn amble_str(amble: &[Tok]) -> Option<String> {
    amble
        .iter()
        .map(|t| match t {
            Tok::Ch(c) => Some(*c),
            Tok::Opaque(_) => None,
        })
        .collect()
}

fn parse_int(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn single_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

/// Zero-pad width for a numeric sequence: bash pads to the widest operand when
/// either endpoint carries a leading zero, otherwise no padding.
fn seq_width(start: &str, end: &str) -> usize {
    if has_leading_zero(start) || has_leading_zero(end) {
        start.len().max(end.len())
    } else {
        0
    }
}

fn has_leading_zero(s: &str) -> bool {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    digits.len() > 1 && digits.starts_with('0')
}

fn fmt_num(v: i64, width: usize) -> String {
    if width == 0 {
        return v.to_string();
    }
    if v < 0 {
        format!("-{:0>width$}", -v, width = width.saturating_sub(1))
    } else {
        format!("{v:0>width$}")
    }
}

fn str_to_toks(s: &str) -> Vec<Tok> {
    s.chars().map(Tok::Ch).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expand a plain literal word and render each result back to a string,
    /// which is enough to exercise every case here (no opaque parts).
    fn expand_str(s: &str) -> Vec<String> {
        expand(&vec![WordPart::Literal(s.to_string())])
            .iter()
            .map(render)
            .collect()
    }

    fn render(word: &Word) -> String {
        word.iter()
            .map(|p| match p {
                WordPart::Literal(s) | WordPart::QuotedLiteral(s) => s.clone(),
                _ => "?".to_string(),
            })
            .collect()
    }

    #[test]
    fn numeric_range() {
        assert_eq!(expand_str("{0..3}"), vec!["0", "1", "2", "3"]);
    }

    #[test]
    fn numeric_range_descending() {
        assert_eq!(expand_str("{3..0}"), vec!["3", "2", "1", "0"]);
    }

    #[test]
    fn numeric_range_with_increment() {
        assert_eq!(expand_str("{1..10..3}"), vec!["1", "4", "7", "10"]);
    }

    #[test]
    fn numeric_range_zero_padded() {
        assert_eq!(
            expand_str("{08..11}"),
            vec!["08", "09", "10", "11"],
            "leading zero pads to the widest operand"
        );
    }

    #[test]
    fn numeric_range_negative() {
        assert_eq!(expand_str("{-2..2}"), vec!["-2", "-1", "0", "1", "2"]);
    }

    #[test]
    fn char_range() {
        assert_eq!(expand_str("{a..e}"), vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn comma_list_with_affixes() {
        assert_eq!(
            expand_str("pre{a,b,c}post"),
            vec!["preapost", "prebpost", "precpost"]
        );
    }

    #[test]
    fn comma_list_empty_element() {
        assert_eq!(expand_str("x{,y}"), vec!["x", "xy"]);
    }

    #[test]
    fn nested_and_multiple_groups() {
        assert_eq!(expand_str("{a,b}{1,2}"), vec!["a1", "a2", "b1", "b2"]);
        assert_eq!(expand_str("{a,{b,c}}"), vec!["a", "b", "c"]);
    }

    #[test]
    fn invalid_groups_stay_literal() {
        assert_eq!(expand_str("{}"), vec!["{}"]);
        assert_eq!(expand_str("{abc}"), vec!["{abc}"]);
        assert_eq!(expand_str("a{b"), vec!["a{b"]);
        assert_eq!(expand_str("{a..}"), vec!["{a..}"]);
    }

    #[test]
    fn literal_group_before_valid_one_expands() {
        assert_eq!(expand_str("{a}{b,c}"), vec!["{a}b", "{a}c"]);
    }
}
