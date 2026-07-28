//! PORT (simplified): vendor/just-bash/src/interpreter/expansion/word-split.ts,
//! vendor/just-bash/src/interpreter/helpers/ifs.ts
//!
//! IFS field splitting for unquoted expansions. Upstream's `smartWordSplit`
//! also threads array/positional-parameter/default-value special cases that
//! don't exist in this port's AST (no arrays, no `${var:-word}` operations);
//! dropping those collapses the algorithm to the two rules bash actually
//! documents:
//!
//! - A word with no unquoted (`Split`) expansion is never subject to word
//!   splitting at all: it always expands to exactly one field, even an empty
//!   one (so `""` and `"$unset"` still produce one empty argument, matching
//!   real bash and unlike upstream's `smartWordSplit` early-return, which is
//!   only ever reached there when a word *does* contain a top-level
//!   expansion type).
//! - Otherwise, the merge loop below is a direct port of `smartWordSplit`'s
//!   mainline branch (`splitByIfsForExpansionEx` + the segment merge), with
//!   the array/mixed-default-value branches removed since nothing in this
//!   AST can produce them.

/// One expanded word part, already reduced to its string value.
pub struct Segment {
    value: String,
    kind: Kind,
}

#[derive(PartialEq, Eq)]
enum Kind {
    /// Unquoted literal text: joins with neighbors, never split (it can't
    /// contain IFS-significant whitespace introduced by expansion, since the
    /// lexer already split on whitespace between words).
    Merge,
    /// Explicitly quoted (a `QuotedLiteral`, or a quoted variable / command
    /// substitution / arithmetic expansion): joins with neighbors like
    /// `Merge`, but "anchors" a field even when everything is empty, since
    /// quoting is what tells bash to keep an empty argument.
    Anchor,
    /// An unquoted variable / command substitution / arithmetic expansion:
    /// subject to IFS splitting.
    Split,
}

impl Segment {
    pub fn merge(value: String) -> Self {
        Self {
            value,
            kind: Kind::Merge,
        }
    }

    pub fn anchor(value: String) -> Self {
        Self {
            value,
            kind: Kind::Anchor,
        }
    }

    pub fn splittable(value: String) -> Self {
        Self {
            value,
            kind: Kind::Split,
        }
    }
}

/// Default IFS: space, tab, newline.
pub const DEFAULT_IFS: &str = " \t\n";

/// Expand a word's segments to zero or more fields per the two rules above.
pub fn expand_fields(segments: &[Segment], ifs: &str) -> Vec<String> {
    if !segments.iter().any(|s| s.kind == Kind::Split) {
        return vec![segments.iter().map(|s| s.value.as_str()).collect()];
    }
    merge_split(segments, ifs)
}

fn is_ifs_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n')
}

struct IfsSplit {
    words: Vec<String>,
    had_leading_delim: bool,
    had_trailing_delim: bool,
}

/// PORT: `splitByIfsForExpansionEx` in ifs.ts, minus the array element-count
/// limit (not a concern for the agent shell's tiny inputs).
fn split_by_ifs(value: &str, ifs: &str) -> IfsSplit {
    if ifs.is_empty() {
        return IfsSplit {
            words: if value.is_empty() {
                vec![]
            } else {
                vec![value.to_string()]
            },
            had_leading_delim: false,
            had_trailing_delim: false,
        };
    }
    if value.is_empty() {
        return IfsSplit {
            words: vec![],
            had_leading_delim: false,
            had_trailing_delim: false,
        };
    }

    let is_ws = |c: char| is_ifs_whitespace(c) && ifs.contains(c);
    let is_non_ws = |c: char| ifs.contains(c) && !is_ifs_whitespace(c);
    let chars: Vec<char> = value.chars().collect();
    let mut pos = 0usize;

    let leading_start = pos;
    while pos < chars.len() && is_ws(chars[pos]) {
        pos += 1;
    }
    let had_leading_delim = pos > leading_start;

    if pos >= chars.len() {
        return IfsSplit {
            words: vec![],
            had_leading_delim: true,
            had_trailing_delim: true,
        };
    }

    let mut words = Vec::new();
    if is_non_ws(chars[pos]) {
        words.push(String::new());
        pos += 1;
        while pos < chars.len() && is_ws(chars[pos]) {
            pos += 1;
        }
    }

    let mut had_trailing_delim = false;
    while pos < chars.len() {
        let word_start = pos;
        while pos < chars.len() && !is_ws(chars[pos]) && !is_non_ws(chars[pos]) {
            pos += 1;
        }
        words.push(chars[word_start..pos].iter().collect());

        if pos >= chars.len() {
            had_trailing_delim = false;
            break;
        }

        let before_delim = pos;
        while pos < chars.len() && is_ws(chars[pos]) {
            pos += 1;
        }
        if pos < chars.len() && is_non_ws(chars[pos]) {
            pos += 1;
            while pos < chars.len() && is_ws(chars[pos]) {
                pos += 1;
            }
            while pos < chars.len() && is_non_ws(chars[pos]) {
                words.push(String::new());
                pos += 1;
                while pos < chars.len() && is_ws(chars[pos]) {
                    pos += 1;
                }
            }
        }
        if pos >= chars.len() && pos > before_delim {
            had_trailing_delim = true;
        }
    }

    IfsSplit {
        words,
        had_leading_delim,
        had_trailing_delim,
    }
}

/// PORT: `smartWordSplit`'s mainline loop in word-split.ts, with the
/// array/mixed-default-value branches removed (see module docs).
fn merge_split(segments: &[Segment], ifs: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_produced = false;
    let mut pending_break = false;
    let mut prev_quoted_empty = false;

    for seg in segments {
        if seg.kind != Kind::Split {
            let quoted = seg.kind == Kind::Anchor;
            if pending_break {
                if quoted && seg.value.is_empty() {
                    if !current.is_empty() {
                        words.push(std::mem::take(&mut current));
                    }
                    words.push(String::new());
                    has_produced = true;
                    pending_break = false;
                    prev_quoted_empty = true;
                } else if !seg.value.is_empty() {
                    if !current.is_empty() {
                        words.push(std::mem::take(&mut current));
                    }
                    current = seg.value.clone();
                    pending_break = false;
                    prev_quoted_empty = false;
                } else {
                    prev_quoted_empty = false;
                }
            } else {
                current.push_str(&seg.value);
                prev_quoted_empty = quoted && seg.value.is_empty();
            }
            continue;
        }

        let split = split_by_ifs(&seg.value, ifs);
        if prev_quoted_empty && split.had_leading_delim && current.is_empty() {
            words.push(String::new());
            has_produced = true;
        }
        match split.words.len() {
            0 => {
                if split.had_trailing_delim {
                    pending_break = true;
                }
            }
            1 => {
                current.push_str(&split.words[0]);
                has_produced = true;
                pending_break = split.had_trailing_delim;
            }
            _ => {
                current.push_str(&split.words[0]);
                words.push(std::mem::take(&mut current));
                has_produced = true;
                for w in &split.words[1..split.words.len() - 1] {
                    words.push(w.clone());
                }
                current = split.words[split.words.len() - 1].clone();
                pending_break = split.had_trailing_delim;
            }
        }
        prev_quoted_empty = false;
    }

    if !current.is_empty() {
        words.push(current);
    } else if words.is_empty() && has_produced {
        words.push(String::new());
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_empty_word_is_one_field() {
        let segs = vec![Segment::anchor(String::new())];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), vec![""]);
    }

    #[test]
    fn unquoted_unset_variable_vanishes() {
        let segs = vec![Segment::splittable(String::new())];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), Vec::<String>::new());
    }

    #[test]
    fn unquoted_variable_splits_on_whitespace() {
        let segs = vec![Segment::splittable("a  b c".to_string())];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), vec!["a", "b", "c"]);
    }

    #[test]
    fn quoted_variable_is_not_split() {
        let segs = vec![Segment::anchor("a b c".to_string())];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), vec!["a b c"]);
    }

    #[test]
    fn split_result_joins_with_adjacent_literal() {
        // `-$x-` where x = "a b c ": ["-a", "b", "c-"] joins first/last with the
        // surrounding literal dashes; the trailing space makes the final `-` its
        // own field rather than joining "c-".
        let segs = vec![
            Segment::merge("-".to_string()),
            Segment::splittable("a b c ".to_string()),
            Segment::merge("-".to_string()),
        ];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), vec!["-a", "b", "c", "-"]);
    }

    #[test]
    fn custom_ifs_non_whitespace_creates_empty_fields() {
        let segs = vec![Segment::splittable("a::b".to_string())];
        assert_eq!(expand_fields(&segs, ":"), vec!["a", "", "b"]);
    }

    #[test]
    fn pure_literal_word_never_splits() {
        let segs = vec![Segment::merge("hello".to_string())];
        assert_eq!(expand_fields(&segs, DEFAULT_IFS), vec!["hello"]);
    }
}
