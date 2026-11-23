//! Python bindings for `src/qwenpaw/agents/context/scroll/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

#![allow(clippy::too_many_arguments)]

use pyo3::prelude::*;
use serde_json::Value;

pub mod js;
pub mod port;
pub mod pyconv;
pub mod pynum;

#[allow(unused_imports)]
use pynum::Num;

fn error(message: String) -> PyErr {
    use pyo3::exceptions as e;
    let (kind, text) = message.split_once(": ").unwrap_or(("", message.as_str()));
    let text = text.to_string();
    match kind {
        "TypeError" => e::PyTypeError::new_err(text),
        "KeyError" => e::PyKeyError::new_err(text),
        "IndexError" => e::PyIndexError::new_err(text),
        "OverflowError" => e::PyOverflowError::new_err(text),
        "ZeroDivisionError" => e::PyZeroDivisionError::new_err(text),
        "AttributeError" => e::PyAttributeError::new_err(text),
        "RuntimeError" => e::PyRuntimeError::new_err(text),
        "NotImplementedError" => e::PyNotImplementedError::new_err(text),
        "LookupError" => e::PyLookupError::new_err(text),
        "ArithmeticError" => e::PyArithmeticError::new_err(text),
        "UnicodeError" => e::PyUnicodeError::new_err(text),
        "ValueError" => e::PyValueError::new_err(text),
        _ => e::PyValueError::new_err(message),
    }
}

fn collapse_blocks_inner(blocks: Bound<'_, PyAny>) -> Result<Value, String> {
    let blocks: Vec<Value> = crate::pyconv::FromPy::from_py(&blocks)?;
    let out = port::collapse_blocks(blocks)?;
    Ok(out)
}

/// `collapse_blocks`.
#[pyfunction]
#[pyo3(name = "collapse_blocks", signature = (blocks))]
fn collapse_blocks(py: Python<'_>, blocks: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    collapse_blocks_inner(blocks)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn apply_eviction_inner(
    tiers: Bound<'_, PyAny>,
    leaves: Bound<'_, PyAny>,
    seq_lo: i64,
    seq_hi: i64,
) -> Result<Vec<Value>, String> {
    let tiers: Vec<Value> = crate::pyconv::FromPy::from_py(&tiers)?;
    let leaves: Vec<Value> = crate::pyconv::FromPy::from_py(&leaves)?;
    let out = port::apply_eviction(tiers, leaves, seq_lo, seq_hi)?;
    Ok(out)
}

/// `apply_eviction`.
#[pyfunction]
#[pyo3(name = "apply_eviction", signature = (tiers, leaves, seq_lo, seq_hi))]
fn apply_eviction(
    py: Python<'_>,
    tiers: Bound<'_, PyAny>,
    leaves: Bound<'_, PyAny>,
    seq_lo: i64,
    seq_hi: i64,
) -> PyResult<Py<PyAny>> {
    apply_eviction_inner(tiers, leaves, seq_lo, seq_hi)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn render_index_inner(
    tiers: Bound<'_, PyAny>,
    include_envelope: bool,
    include_live_banner: bool,
    detail_char_budget: Option<i64>,
) -> Result<String, String> {
    let tiers: Vec<Value> = crate::pyconv::FromPy::from_py(&tiers)?;
    let out = port::render_index(
        tiers,
        include_envelope,
        include_live_banner,
        detail_char_budget,
    )?;
    Ok(out)
}

/// `render_index`.
#[pyfunction]
#[pyo3(name = "render_index", signature = (tiers, include_envelope=true, include_live_banner=true, detail_char_budget=None))]
fn render_index(
    tiers: Bound<'_, PyAny>,
    include_envelope: bool,
    include_live_banner: bool,
    detail_char_budget: Option<i64>,
) -> PyResult<String> {
    render_index_inner(
        tiers,
        include_envelope,
        include_live_banner,
        detail_char_budget,
    )
    .map_err(error)
}

fn describe_index_inner(tiers: Bound<'_, PyAny>) -> Result<String, String> {
    let tiers: Vec<Value> = crate::pyconv::FromPy::from_py(&tiers)?;
    let out = port::describe_index(tiers)?;
    Ok(out)
}

/// `describe_index`.
#[pyfunction]
#[pyo3(name = "describe_index", signature = (tiers))]
fn describe_index(tiers: Bound<'_, PyAny>) -> PyResult<String> {
    describe_index_inner(tiers).map_err(error)
}

fn bounded_headline_inner(text: String, limit: i64) -> Result<String, String> {
    let out = port::bounded_headline(text, limit)?;
    Ok(out)
}

/// `bounded_headline`.
#[pyfunction]
#[pyo3(name = "bounded_headline", signature = (text, limit))]
fn bounded_headline(text: String, limit: i64) -> PyResult<String> {
    bounded_headline_inner(text, limit).map_err(error)
}

fn bounded_line_text_inner(line: Bound<'_, PyAny>, limit: i64) -> Result<String, String> {
    let line: Value = crate::pyconv::FromPy::from_py(&line)?;
    let out = port::bounded_line_text(line, limit)?;
    Ok(out)
}

/// `bounded_line_text`.
#[pyfunction]
#[pyo3(name = "bounded_line_text", signature = (line, limit))]
fn bounded_line_text(line: Bound<'_, PyAny>, limit: i64) -> PyResult<String> {
    bounded_line_text_inner(line, limit).map_err(error)
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(collapse_blocks, m)?)?;
    m.add_function(wrap_pyfunction!(apply_eviction, m)?)?;
    m.add_function(wrap_pyfunction!(render_index, m)?)?;
    m.add_function(wrap_pyfunction!(describe_index, m)?)?;
    m.add_function(wrap_pyfunction!(bounded_headline, m)?)?;
    m.add_function(wrap_pyfunction!(bounded_line_text, m)?)?;
    Ok(())
}
