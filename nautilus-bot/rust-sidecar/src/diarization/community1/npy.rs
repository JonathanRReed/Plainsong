//! Minimal `.npy` / `.npz` reader for the two PLDA archives community-1
//! ships (`plda.npz`, `xvec_transform.npz`). Both are uncompressed ("stored")
//! zip archives of little-endian `float64` / `float32` C-order arrays; anything
//! else is refused rather than guessed at.

use anyhow::{anyhow, bail, Context, Result};
use std::io::Read;
use std::path::Path;

/// A dense array widened to `f64`, with its shape.
#[derive(Debug, Clone)]
pub(super) struct NpyArray {
    pub shape: Vec<usize>,
    pub data: Vec<f64>,
}

/// Parse one `.npy` payload.
pub(super) fn parse_npy(bytes: &[u8]) -> Result<NpyArray> {
    if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
        bail!("not a .npy array");
    }
    let major = bytes[6];
    let (header_len, header_start) = match major {
        1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
        2 | 3 => {
            if bytes.len() < 12 {
                bail!("truncated .npy header");
            }
            (
                u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
                12,
            )
        }
        other => bail!("unsupported .npy version {other}"),
    };
    let header_end = header_start + header_len;
    let header = std::str::from_utf8(
        bytes
            .get(header_start..header_end)
            .ok_or_else(|| anyhow!("truncated .npy header"))?,
    )
    .context(".npy header is not UTF-8")?;

    let descr = header_value(header, "descr")?;
    let descr = descr.trim_matches(|c| c == '\'' || c == '"');
    let fortran = header_value(header, "fortran_order")?;
    if fortran.trim() != "False" {
        bail!("Fortran-ordered .npy arrays are not supported");
    }
    let shape_text = header_value(header, "shape")?;
    let shape: Vec<usize> = shape_text
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<usize>().context("bad .npy shape"))
        .collect::<Result<_>>()?;
    let count: usize = shape.iter().product();
    let payload = &bytes[header_end..];
    let data = match descr {
        "<f8" => {
            if payload.len() != count * 8 {
                bail!(
                    "float64 payload is {} bytes, expected {}",
                    payload.len(),
                    count * 8
                );
            }
            payload
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes(c.try_into().expect("8 bytes")))
                .collect()
        }
        "<f4" => {
            if payload.len() != count * 4 {
                bail!(
                    "float32 payload is {} bytes, expected {}",
                    payload.len(),
                    count * 4
                );
            }
            payload
                .chunks_exact(4)
                .map(|c| f64::from(f32::from_le_bytes(c.try_into().expect("4 bytes"))))
                .collect()
        }
        other => bail!("unsupported .npy dtype {other}"),
    };
    Ok(NpyArray { shape, data })
}

/// The text after `'key':` up to the next top-level comma or closing brace.
fn header_value<'a>(header: &'a str, key: &str) -> Result<&'a str> {
    let marker = format!("'{key}':");
    let start = header
        .find(&marker)
        .ok_or_else(|| anyhow!(".npy header has no {key}"))?
        + marker.len();
    let rest = &header[start..];
    let mut depth = 0i32;
    for (index, ch) in rest.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' | '}' if depth == 0 => return Ok(rest[..index].trim()),
            _ => {}
        }
    }
    Err(anyhow!(".npy header value for {key} is not terminated"))
}

/// Read named arrays from an `.npz` archive whose bytes match `sha256`.
pub(super) fn read_npz(path: &Path, sha256: &str, names: &[&str]) -> Result<Vec<NpyArray>> {
    let bytes = crate::download::read_verified_model_bytes(path, sha256)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .with_context(|| format!("{} is not a valid .npz archive", path.display()))?;
    names
        .iter()
        .map(|name| {
            let mut entry = archive
                .by_name(&format!("{name}.npy"))
                .with_context(|| format!("{} has no {name}.npy", path.display()))?;
            if entry.size() > 16 * 1024 * 1024 {
                bail!("{name}.npy in {} is implausibly large", path.display());
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes)?;
            parse_npy(&bytes).with_context(|| format!("{name}.npy in {}", path.display()))
        })
        .collect()
}

/// Write a C-order array as `.npy` (parity harness only).
pub(super) fn write_npy(path: &Path, descr: &str, shape: &[usize], payload: &[u8]) -> Result<()> {
    let shape_text = match shape {
        [single] => format!("({single},)"),
        _ => format!(
            "({})",
            shape
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    let mut header =
        format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': {shape_text}, }}");
    while (10 + header.len() + 1) % 64 != 0 {
        header.push(' ');
    }
    header.push('\n');
    let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
    bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
    bytes.extend_from_slice(header.as_bytes());
    bytes.extend_from_slice(payload);
    std::fs::write(path, bytes).with_context(|| format!("Failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npy(descr: &str, shape: &str, payload: &[u8]) -> Vec<u8> {
        npy_with_order(descr, "False", shape, payload)
    }

    fn npy_with_order(descr: &str, fortran: &str, shape: &str, payload: &[u8]) -> Vec<u8> {
        let mut header =
            format!("{{'descr': '{descr}', 'fortran_order': {fortran}, 'shape': {shape}, }}");
        while (10 + header.len() + 1) % 64 != 0 {
            header.push(' ');
        }
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn reads_float64_and_float32_arrays() {
        let payload: Vec<u8> = [1.5f64, -2.0, 3.25, 4.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let array = parse_npy(&npy("<f8", "(2, 2)", &payload)).unwrap();
        assert_eq!(array.shape, vec![2, 2]);
        assert_eq!(array.data, vec![1.5, -2.0, 3.25, 4.0]);

        let payload: Vec<u8> = [0.5f32, 7.0, -1.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let array = parse_npy(&npy("<f4", "(3,)", &payload)).unwrap();
        assert_eq!(array.shape, vec![3]);
        assert_eq!(array.data, vec![0.5, 7.0, -1.0]);
    }

    #[test]
    fn refuses_other_dtypes_orders_and_short_payloads() {
        assert!(parse_npy(&npy("<i8", "(1,)", &[0; 8])).is_err());
        assert!(parse_npy(&npy("<f8", "(2,)", &[0; 8])).is_err());
        assert!(parse_npy(&npy_with_order("<f8", "True", "(1,)", &[0; 8])).is_err());
        assert!(parse_npy(b"not numpy").is_err());
    }
}
