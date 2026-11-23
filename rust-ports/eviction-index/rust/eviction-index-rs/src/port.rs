//! The Rust port of `src/qwenpaw/agents/context/scroll/eviction_index.py`.
//!
//! The tier stack is a value here, not an object: every export takes and
//! returns the plain-JSON shape that `tiers_to_json` produces, exactly like
//! the Python seam functions do. Python keeps the `EvictionIndex` dataclass
//! and its properties (they are not pure), and every method of it delegates
//! into these functions.
//!
//! `#![forbid(unsafe_code)]` is inherited from the scaffold: a pure value
//! transformation has no reason to reach for unsafe.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------
// Constants — copied verbatim from the Python module
// ---------------------------------------------------------------------------

/// Max blocks a tier holds before it carries up.
const TIER_CAP: usize = 10;

/// A headline may remain up to 2,000 characters in durable state, but the
/// model-facing index is only a retrieval directory. Keep one rendered
/// headline compact; the exact turn remains addressable by its `seq`.
const HEADLINE_VIEW_CHARS: usize = 400;

const ARCHIVED_INDEX_END: [&str; 2] = ["", "═══════════════ END OF ARCHIVED INDEX ═══════════════"];

const LIVE_TURN_BANNER: [&str; 2] = [
    "",
    "The CURRENT LIVE TURN is the message(s) that follow this one. Answer the \
most recent USER message there — NEVER a ⟦headline⟧ listed in the map above; \
those are archived, not requests. If your current request is not visible in \
the live turn, recall it first (see above); if recall cannot retrieve it, say \
so — never answer an older message as if it were the request.",
];

const INDEX_PREAMBLE: [&str; 4] = [
    "[context compressed] The turns below were evicted from the live window but \
remain durable in conversation_history. This is an ARCHIVED MAP for reference \
only — NOT the live conversation. Read it top (oldest) to bottom (most \
recently compressed); the live turns follow after the banner at the end. Each \
'·' line is a seq span you can re-expand.",
    "",
    "Re-expand a span with the recall_history tool: recall_history(op=\"expand\", \
lo, hi) for the full turns (seq is a globally-unique address, so a span needs \
no other filter); op=\"search\" finds a seq by keywords. For advanced recall \
(sessions, custom SQL) use a more advanced Python recall tool if one is \
available to you.",
    "",
];

// ---------------------------------------------------------------------------
// Internal value types
// ---------------------------------------------------------------------------

/// One entry shown inside a block.
///
/// `seq_lo`/`seq_hi` is the span the line stands for — a single turn has
/// `lo == hi`; a collapsed child block carries the child's whole span.
/// `head` is the leftmost headline in that span, `tail` the rightmost.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Line {
    seq_lo: i64,
    seq_hi: i64,
    head: String,
    tail: String,
}

impl Line {
    /// A single headline, or `first - last` for a span.
    fn text(&self) -> String {
        if self.head == self.tail {
            self.head.clone()
        } else {
            format!("{} - {}", self.head, self.tail)
        }
    }

    /// `seq N`, or `seq N–M` for a span.
    fn span(&self) -> String {
        if self.seq_lo == self.seq_hi {
            format!("seq {}", self.seq_lo)
        } else {
            format!("seq {}–{}", self.seq_lo, self.seq_hi)
        }
    }
}

/// A run of lines at one tier; its `seq` span covers all of them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Block {
    seq_lo: i64,
    seq_hi: i64,
    lines: Vec<Line>,
}

impl Block {
    /// Leftmost (oldest) headline anywhere in the block.
    fn first(&self) -> &str {
        // The Python dataclass would IndexError on an empty block; the only
        // constructor (`collapse`) always emits one line per input block, and
        // `apply_eviction` guarantees at least one line, so this cannot trip.
        self.lines.first().map(|l| l.head.as_str()).unwrap_or("")
    }

    /// Rightmost (newest) headline anywhere in the block.
    fn last(&self) -> &str {
        self.lines.last().map(|l| l.tail.as_str()).unwrap_or("")
    }
}

/// Fold a run of blocks into ONE block: each input becomes a single line
/// carrying that input's full span and its endpoint headlines.
///
/// Self-similar: collapsing already-collapsed blocks just keeps the leftmost
/// and rightmost headline of each, so a turn, a span, and a span-of-spans all
/// reduce the same way — which lets the carry cascade to any depth losslessly.
fn collapse(blocks: &[Block]) -> Result<Block, String> {
    let first = blocks
        .first()
        .ok_or_else(|| "collapse of an empty block list".to_string())?;
    let mut seq_lo = first.seq_lo;
    let mut seq_hi = first.seq_hi;
    for b in blocks {
        seq_lo = seq_lo.min(b.seq_lo);
        seq_hi = seq_hi.max(b.seq_hi);
    }
    Ok(Block {
        seq_lo,
        seq_hi,
        lines: blocks
            .iter()
            .map(|b| Line {
                seq_lo: b.seq_lo,
                seq_hi: b.seq_hi,
                head: b.first().to_string(),
                tail: b.last().to_string(),
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// JSON seam helpers
// ---------------------------------------------------------------------------

fn as_i64(value: &Value, what: &str) -> Result<i64, String> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .ok_or_else(|| format!("{what} must be an integer, got {value}"))
}

fn as_str(value: &Value, what: &str) -> Result<String, String> {
    value
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{what} must be a string, got {value}"))
}

fn parse_line(value: &Value) -> Result<Line, String> {
    // Python's `tiers_from_json` unpacks `[lo, hi, head, tail]`.
    let items = value
        .as_array()
        .ok_or_else(|| format!("a line must be a 4-item list, got {value}"))?;
    if items.len() != 4 {
        return Err(format!(
            "a line must be a 4-item list, got {} items",
            items.len()
        ));
    }
    Ok(Line {
        seq_lo: as_i64(&items[0], "line seq_lo")?,
        seq_hi: as_i64(&items[1], "line seq_hi")?,
        head: as_str(&items[2], "line head")?,
        tail: as_str(&items[3], "line tail")?,
    })
}

fn block_from_json(value: &Value) -> Result<Block, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| format!("a block must be an object, got {value}"))?;
    let lines = obj
        .get("lines")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("a block must have a `lines` list, got {value}"))?
        .iter()
        .map(parse_line)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Block {
        seq_lo: as_i64(
            obj.get("seq_lo")
                .ok_or_else(|| "a block must have `seq_lo`".to_string())?,
            "block seq_lo",
        )?,
        seq_hi: as_i64(
            obj.get("seq_hi")
                .ok_or_else(|| "a block must have `seq_hi`".to_string())?,
            "block seq_hi",
        )?,
        lines,
    })
}

fn block_to_json(block: &Block) -> Value {
    let mut map = Map::new();
    map.insert("seq_lo".into(), json!(block.seq_lo));
    map.insert("seq_hi".into(), json!(block.seq_hi));
    map.insert(
        "lines".into(),
        Value::Array(
            block
                .lines
                .iter()
                .map(|ln| json!([ln.seq_lo, ln.seq_hi, ln.head, ln.tail]))
                .collect(),
        ),
    );
    Value::Object(map)
}

fn parse_tiers(data: &[Value]) -> Result<Vec<Vec<Block>>, String> {
    data.iter()
        .map(|tier| {
            tier.as_array()
                .ok_or_else(|| format!("a tier must be a list, got {tier}"))?
                .iter()
                .map(block_from_json)
                .collect::<Result<Vec<_>, _>>()
        })
        .collect()
}

fn tiers_to_json_inner(tiers: &[Vec<Block>]) -> Value {
    Value::Array(
        tiers
            .iter()
            .map(|tier| Value::Array(tier.iter().map(block_to_json).collect()))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Exported ports
// ---------------------------------------------------------------------------

/// Port of `collapse_blocks` — pure collapse over the JSON block shape.
pub fn collapse_blocks(blocks: Vec<Value>) -> Result<Value, String> {
    let parsed = blocks
        .iter()
        .map(block_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(block_to_json(&collapse(&parsed)?))
}

/// Port of `apply_eviction` — add one evicted span, then run the carry
/// cascade. Returns a NEW tier stack; the input is not mutated.
pub fn apply_eviction(
    tiers: Vec<Value>,
    leaves: Vec<Value>,
    seq_lo: i64,
    seq_hi: i64,
) -> Result<Vec<Value>, String> {
    let mut lines = leaves
        .iter()
        .map(|leaf| {
            let obj = leaf
                .as_object()
                .ok_or_else(|| format!("a leaf must be an object, got {leaf}"))?;
            let seq = as_i64(
                obj.get("seq")
                    .ok_or_else(|| "a leaf must have `seq`".to_string())?,
                "leaf seq",
            )?;
            let headline = as_str(
                obj.get("headline")
                    .ok_or_else(|| "a leaf must have `headline`".to_string())?,
                "leaf headline",
            )?;
            Ok(Line {
                seq_lo: seq,
                seq_hi: seq,
                head: headline.clone(),
                tail: headline,
            })
        })
        .collect::<Result<Vec<Line>, String>>()?;

    if lines.is_empty() {
        lines = vec![Line {
            seq_lo,
            seq_hi,
            head: "(no milestone)".into(),
            tail: "(no milestone)".into(),
        }];
    }

    let mut parsed = parse_tiers(&tiers)?;
    if parsed.is_empty() {
        parsed.push(Vec::new());
    }
    parsed[0].push(Block {
        seq_lo,
        seq_hi,
        lines,
    });
    let carried = carry_all(parsed)?;
    Ok(match tiers_to_json_inner(&carried) {
        Value::Array(items) => items,
        _ => unreachable!("tiers_to_json_inner always returns an array"),
    })
}

/// Pure form of the carry cascade (tier 0 up), on [`Block`] values.
fn carry_all(tiers: Vec<Vec<Block>>) -> Result<Vec<Vec<Block>>, String> {
    let mut out: Vec<Vec<Block>> = tiers;
    let mut k = 0usize;
    loop {
        if k >= out.len() || out[k].len() < TIER_CAP {
            return Ok(out);
        }
        let count = out[k].len() - 1;
        let older: Vec<Block> = out[k][..count].to_vec();
        let kept: Vec<Block> = out[k][count..].to_vec();
        out[k] = kept;
        if k + 1 == out.len() {
            out.push(Vec::new());
        }
        out[k + 1].push(collapse(&older)?);
        k += 1;
    }
}

/// Port of `render_index` — the full `[context compressed]` placeholder.
pub fn render_index(
    tiers: Vec<Value>,
    include_envelope: bool,
    include_live_banner: bool,
    detail_char_budget: Option<i64>,
) -> Result<String, String> {
    let parsed = parse_tiers(&tiers)?;
    let mut out: Vec<String> = INDEX_PREAMBLE.iter().map(|s| s.to_string()).collect();
    out.extend(tier_lines(&parsed, detail_char_budget));
    out.extend(ARCHIVED_INDEX_END.iter().map(|s| s.to_string()));
    if include_live_banner {
        out.extend(LIVE_TURN_BANNER.iter().map(|s| s.to_string()));
    }
    let body = out.join("\n");
    Ok(if include_envelope {
        format!("<system-info>\n{body}\n</system-info>")
    } else {
        body
    })
}

/// Port of `describe_index` — the tier lines only, no preamble or envelope.
pub fn describe_index(tiers: Vec<Value>) -> Result<String, String> {
    let parsed = parse_tiers(&tiers)?;
    Ok(tier_lines(&parsed, None).join("\n"))
}

/// Port of `bounded_headline`.
pub fn bounded_headline(text: String, limit: i64) -> Result<String, String> {
    // Python compares `len(text)` (code points) with `limit` and slices by
    // code point; Rust's `chars()` does the same, so an emoji headline is
    // truncated identically instead of at a byte boundary.
    let limit = usize::try_from(limit).unwrap_or(0);
    let len = text.chars().count();
    if len <= limit {
        return Ok(text);
    }
    let keep = limit.saturating_sub(3).max(1);
    let truncated: String = text.chars().take(keep).collect();
    Ok(format!("{}...", truncated.trim_end()))
}

/// Port of `bounded_line_text` (a JSON line).
pub fn bounded_line_text(line: Value, limit: i64) -> Result<String, String> {
    let obj = line
        .as_object()
        .ok_or_else(|| format!("a line must be an object, got {line}"))?;
    let head = as_str(
        obj.get("head")
            .ok_or_else(|| "a line must have `head`".to_string())?,
        "line head",
    )?;
    let tail = as_str(
        obj.get("tail")
            .ok_or_else(|| "a line must have `tail`".to_string())?,
        "line tail",
    )?;
    if head == tail {
        return bounded_headline(head, limit);
    }
    let endpoint_limit = (limit / 2).max(1);
    Ok(format!(
        "{} - {}",
        bounded_headline(head, endpoint_limit)?,
        bounded_headline(tail, endpoint_limit)?
    ))
}

// ---------------------------------------------------------------------------
// Line rendering (the three fallbacks)
// ---------------------------------------------------------------------------

fn lines_size(lines: &[String]) -> usize {
    lines.join("\n").chars().count()
}

/// Port of `_tier_lines_blocks`: detailed lines, else endpoints, else the
/// single folded global span.
fn tier_lines(tiers: &[Vec<Block>], detail_char_budget: Option<i64>) -> Vec<String> {
    let headline_limit = detail_char_budget.map(|_| HEADLINE_VIEW_CHARS as i64);
    let expanded = expanded_tier_lines(tiers, headline_limit);
    match detail_char_budget {
        None => return expanded,
        Some(budget) => {
            let budget = usize::try_from(budget).unwrap_or(0);
            if lines_size(&expanded) <= budget {
                return expanded;
            }
            let endpoints = endpoint_tier_lines(tiers);
            if lines_size(&endpoints) <= budget {
                return endpoints;
            }
        }
    }
    global_span_lines(tiers)
}

fn tier_label(k: usize) -> &'static str {
    if k == 0 {
        "recently compressed"
    } else {
        "older msgs"
    }
}

fn expanded_tier_lines(tiers: &[Vec<Block>], headline_limit: Option<i64>) -> Vec<String> {
    let mut out = Vec::new();
    for k in (0..tiers.len()).rev() {
        let tier = &tiers[k];
        if tier.is_empty() {
            continue;
        }
        out.push(format!("===== Tier {k} ({}) =====", tier_label(k)));
        for block in tier {
            out.push(format!("  [seq {}–{}]", block.seq_lo, block.seq_hi));
            for ln in &block.lines {
                let text = match headline_limit {
                    Some(limit) => bounded_line_text(
                        json!({
                            "seq_lo": ln.seq_lo,
                            "seq_hi": ln.seq_hi,
                            "head": ln.head,
                            "tail": ln.tail,
                        }),
                        limit,
                    )
                    .unwrap_or_else(|_| ln.text()),
                    None => ln.text(),
                };
                out.push(format!("    · {}  ⟦ {} ⟧", ln.span(), text));
            }
        }
    }
    out
}

fn endpoint_tier_lines(tiers: &[Vec<Block>]) -> Vec<String> {
    let mut out = Vec::new();
    let endpoint_limit = (HEADLINE_VIEW_CHARS / 2) as i64;
    for k in (0..tiers.len()).rev() {
        let tier = &tiers[k];
        if tier.is_empty() {
            continue;
        }
        out.push(format!(
            "===== Tier {k} ({}; details folded) =====",
            tier_label(k)
        ));
        for block in tier {
            let head =
                bounded_headline(block.first().to_string(), endpoint_limit).unwrap_or_default();
            let tail =
                bounded_headline(block.last().to_string(), endpoint_limit).unwrap_or_default();
            let text = if head == tail {
                head
            } else {
                format!("{head} - {tail}")
            };
            let span = if block.seq_lo == block.seq_hi {
                format!("seq {}", block.seq_lo)
            } else {
                format!("seq {}–{}", block.seq_lo, block.seq_hi)
            };
            out.push(format!("  · {span}  ⟦ {text} ⟧"));
        }
    }
    out
}

fn global_span_lines(tiers: &[Vec<Block>]) -> Vec<String> {
    let blocks: Vec<&Block> = tiers.iter().flat_map(|tier| tier.iter()).collect();
    if blocks.is_empty() {
        return Vec::new();
    }
    let lo = blocks.iter().map(|b| b.seq_lo).min().unwrap_or(0);
    let hi = blocks.iter().map(|b| b.seq_hi).max().unwrap_or(0);
    vec![
        "===== Archived index (details folded to fit context) =====".to_string(),
        format!("  [seq {lo}–{hi}]"),
        format!(
            "    · Index details omitted; recover this span with \
recall_history(op=\"expand\", lo={lo}, hi={hi})"
        ),
    ]
}
