//! A minimal Word (.docx) writer over the `zip` crate already in the tree.
//!
//! Word files are a zip of XML parts. This module writes the four that make a
//! document Word and Pages will open — `[Content_Types].xml`, the package
//! relationships, `word/document.xml` with its own relationships,
//! `word/styles.xml`, and `word/numbering.xml` for lists — from the Markdown
//! the Markdown export already produces. Understood: `#`/`##`/`###`
//! headings, paragraphs, `-`/`*` bullets, `1.` numbered items, `>` quotes,
//! `---` rules, and inline `**bold**`, `*italic*`, `` `code` ``. No images,
//! no tables; a line the parser does not recognise is a paragraph, never
//! dropped. Everything user-written is XML-escaped.

use std::io::{Cursor, Write};

use anyhow::{Context, Result};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;

const PACKAGE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOCUMENT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>"#;

const NUMBERING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#;

const BULLET_NUM_ID: u32 = 1;
const DECIMAL_NUM_ID: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Heading(u8, String),
    Paragraph(String),
    Quote(String),
    Bullet(String),
    Numbered(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Run {
    text: String,
    bold: bool,
    italic: bool,
    code: bool,
}

/// Parse the Markdown subset. Every non-blank line is one block: the export's
/// own Markdown separates paragraphs with blank lines, and a note's hard
/// line breaks are meant.
fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    for raw in markdown.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        if is_rule(trimmed) {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("### ") {
            blocks.push(Block::Heading(3, rest.trim().to_string()));
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            blocks.push(Block::Heading(2, rest.trim().to_string()));
        } else if let Some(rest) = trimmed.strip_prefix("# ") {
            blocks.push(Block::Heading(1, rest.trim().to_string()));
        } else if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            blocks.push(Block::Bullet(rest.trim().to_string()));
        } else if let Some(rest) = numbered_item(trimmed) {
            blocks.push(Block::Numbered(rest));
        } else if let Some(rest) = trimmed.strip_prefix('>') {
            blocks.push(Block::Quote(rest.trim().to_string()));
        } else {
            blocks.push(Block::Paragraph(trimmed.to_string()));
        }
    }
    blocks
}

fn is_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3
        && (compact.chars().all(|c| c == '-')
            || compact.chars().all(|c| c == '*')
            || compact.chars().all(|c| c == '_'))
}

fn numbered_item(line: &str) -> Option<String> {
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &line[digits.len()..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    let rest = rest.strip_prefix(' ')?;
    Some(rest.trim().to_string())
}

/// Split inline Markdown into styled runs. A marker with no partner is kept
/// as the literal character the writer typed.
fn parse_runs(text: &str) -> Vec<Run> {
    let chars: Vec<char> = text.chars().collect();
    // Record whether a boundary-valid closing underscore exists later in the
    // line. Building this suffix table once keeps unmatched opener candidates
    // from each rescanning the remainder of an attacker-controlled line.
    let mut underscore_closer_after = vec![false; chars.len()];
    let mut has_underscore_closer = false;
    for index in (0..chars.len()).rev() {
        underscore_closer_after[index] = has_underscore_closer;
        if chars[index] == '_' && underscore_closes_at(&chars, index) {
            has_underscore_closer = true;
        }
    }
    let mut runs: Vec<Run> = Vec::new();
    let mut buffer = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut code = false;
    let mut index = 0;

    let flush = |buffer: &mut String, runs: &mut Vec<Run>, bold: bool, italic: bool, code: bool| {
        if !buffer.is_empty() {
            runs.push(Run {
                text: std::mem::take(buffer),
                bold,
                italic,
                code,
            });
        }
    };

    while index < chars.len() {
        let c = chars[index];
        if c == '`' {
            let closes = code || chars[index + 1..].contains(&'`');
            if closes {
                flush(&mut buffer, &mut runs, bold, italic, code);
                code = !code;
                index += 1;
                continue;
            }
        } else if !code && c == '*' && chars.get(index + 1) == Some(&'*') {
            let closes = bold || has_pair(&chars[index + 2..], &['*', '*']);
            if closes {
                flush(&mut buffer, &mut runs, bold, italic, code);
                bold = !bold;
                index += 2;
                continue;
            }
        } else if !code && c == '*' {
            let closes = italic || chars[index + 1..].contains(&c);
            if closes {
                flush(&mut buffer, &mut runs, bold, italic, code);
                italic = !italic;
                index += 1;
                continue;
            }
        } else if !code && c == '_' {
            let closes = if italic {
                underscore_closes_at(&chars, index)
            } else {
                underscore_opens_at(&chars, index, underscore_closer_after[index])
            };
            if closes {
                flush(&mut buffer, &mut runs, bold, italic, code);
                italic = !italic;
                index += 1;
                continue;
            }
        }
        buffer.push(c);
        index += 1;
    }
    flush(&mut buffer, &mut runs, bold, italic, code);
    runs
}

fn has_pair(haystack: &[char], needle: &[char; 2]) -> bool {
    haystack.windows(2).any(|w| w == needle)
}

/// `_` marks emphasis only at a word boundary, the way every Markdown reader
/// treats it. Without this, `file_name_here` lost both underscores and came
/// out of the export in italics: any later `_` was taken as the partner of the
/// first, whatever it was attached to.
fn underscore_opens_at(chars: &[char], index: usize, has_closer_after: bool) -> bool {
    let before = index.checked_sub(1).map(|previous| chars[previous]);
    let after = chars.get(index + 1).copied();
    before.is_none_or(|character| !character.is_alphanumeric() && character != '_')
        && after.is_some_and(|character| !character.is_whitespace() && character != '_')
        && has_closer_after
}

fn underscore_closes_at(chars: &[char], index: usize) -> bool {
    let before = index.checked_sub(1).map(|previous| chars[previous]);
    let after = chars.get(index + 1).copied();
    before.is_some_and(|character| !character.is_whitespace() && character != '_')
        && after.is_none_or(|character| !character.is_alphanumeric())
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            // XML 1.0 forbids most control characters outright, and excludes
            // U+FFFE/U+FFFF from its `Char` production as well; drop them
            // rather than emit a file Word refuses to open.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => escaped.push(c),
        }
    }
    escaped
}

fn write_runs(out: &mut String, runs: &[Run]) {
    for run in runs {
        out.push_str("<w:r>");
        if run.bold || run.italic || run.code {
            out.push_str("<w:rPr>");
            if run.code {
                out.push_str(
                    r#"<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>"#,
                );
            }
            if run.bold {
                out.push_str("<w:b/>");
            }
            if run.italic {
                out.push_str("<w:i/>");
            }
            out.push_str("</w:rPr>");
        }
        out.push_str(r#"<w:t xml:space="preserve">"#);
        out.push_str(&escape_xml(&run.text));
        out.push_str("</w:t></w:r>");
    }
}

fn write_paragraph(out: &mut String, style: Option<&str>, num_id: Option<u32>, text: &str) {
    out.push_str("<w:p>");
    if style.is_some() || num_id.is_some() {
        out.push_str("<w:pPr>");
        if let Some(style) = style {
            out.push_str(&format!(r#"<w:pStyle w:val="{style}"/>"#));
        }
        if let Some(num_id) = num_id {
            out.push_str(&format!(
                r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>"#
            ));
        }
        out.push_str("</w:pPr>");
    }
    write_runs(out, &parse_runs(text));
    out.push_str("</w:p>");
}

fn document_xml(markdown: &str) -> String {
    let mut body = String::new();
    for block in parse_blocks(markdown) {
        match block {
            Block::Heading(level, text) => {
                let style = format!("Heading{level}");
                write_paragraph(&mut body, Some(&style), None, &text);
            }
            Block::Paragraph(text) => write_paragraph(&mut body, None, None, &text),
            Block::Quote(text) => write_paragraph(&mut body, Some("Quote"), None, &text),
            Block::Bullet(text) => {
                write_paragraph(&mut body, Some("ListParagraph"), Some(BULLET_NUM_ID), &text)
            }
            Block::Numbered(text) => write_paragraph(
                &mut body,
                Some("ListParagraph"),
                Some(DECIMAL_NUM_ID),
                &text,
            ),
        }
    }
    if body.is_empty() {
        // A document needs at least one paragraph to be a document.
        body.push_str("<w:p/>");
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

/// The bytes of a .docx built from `markdown`.
pub fn markdown_to_docx(markdown: &str) -> Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let parts: [(&str, String); 6] = [
        ("[Content_Types].xml", CONTENT_TYPES.to_string()),
        ("_rels/.rels", PACKAGE_RELS.to_string()),
        ("word/document.xml", document_xml(markdown)),
        ("word/_rels/document.xml.rels", DOCUMENT_RELS.to_string()),
        ("word/styles.xml", STYLES.to_string()),
        ("word/numbering.xml", NUMBERING.to_string()),
    ];
    for (name, contents) in parts {
        zip.start_file(name, options)
            .with_context(|| format!("Failed to start docx part {name}"))?;
        zip.write_all(contents.as_bytes())
            .with_context(|| format!("Failed to write docx part {name}"))?;
    }
    let cursor = zip.finish().context("Failed to finish docx archive")?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const SAMPLE: &str = "# Limited beta review\n\n**Date:** 2026-08-09 | **Duration:** 1m 30s\n\n---\n\n## Action Items\n\n- Jonathan confirms export before beta invites. (Owner: Jonathan · Due: Friday)\n- Second `item` & *more*\n\n## Steps\n\n1. First step\n2. Second step\n\n> A quoted line <with> \"angles\"\n\nPlain paragraph with an unmatched * asterisk.\n";

    fn parts(bytes: &[u8]) -> Vec<(String, String)> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("docx is a zip");
        let mut out = Vec::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).expect("zip entry");
            let mut contents = String::new();
            file.read_to_string(&mut contents).expect("utf-8 part");
            out.push((file.name().to_string(), contents));
        }
        out
    }

    /// A small well-formedness check: every open tag closes in order, no raw
    /// `<` or `&` in text, attributes quoted. Enough to catch an escaping slip
    /// without an XML crate in the tree.
    fn assert_well_formed(name: &str, xml: &str) {
        let mut stack: Vec<String> = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find('<') {
            let text = &rest[..start];
            assert!(
                !text.contains('&')
                    || text.contains("&amp;")
                    || text.contains("&lt;")
                    || text.contains("&gt;")
                    || text.contains("&quot;")
                    || text.contains("&#"),
                "{name}: raw ampersand in text {text:?}"
            );
            for piece in text.split('&').skip(1) {
                let entity: String = piece.chars().take_while(|c| *c != ';').collect();
                assert!(
                    matches!(entity.as_str(), "amp" | "lt" | "gt" | "quot" | "apos")
                        || entity.starts_with('#'),
                    "{name}: unknown entity &{entity};"
                );
            }
            let end = rest[start..]
                .find('>')
                .map(|e| start + e)
                .expect("tag closes");
            let tag = &rest[start + 1..end];
            if tag.starts_with('?') || tag.starts_with('!') {
                rest = &rest[end + 1..];
                continue;
            }
            if let Some(closing) = tag.strip_prefix('/') {
                let open = stack
                    .pop()
                    .unwrap_or_else(|| panic!("{name}: stray closing tag {closing}"));
                assert_eq!(open, closing.trim(), "{name}: mismatched tags");
            } else if tag.ends_with('/') {
                // self-closing
            } else {
                let tag_name: String = tag.chars().take_while(|c| !c.is_whitespace()).collect();
                let attrs = &tag[tag_name.len()..];
                let quotes = attrs.matches('"').count();
                assert_eq!(
                    quotes % 2,
                    0,
                    "{name}: unbalanced attribute quotes in <{tag}>"
                );
                stack.push(tag_name);
            }
            rest = &rest[end + 1..];
        }
        assert!(stack.is_empty(), "{name}: unclosed tags {stack:?}");
    }

    #[test]
    fn docx_carries_the_required_parts_and_well_formed_xml() {
        let bytes = markdown_to_docx(SAMPLE).expect("build docx");
        assert_eq!(&bytes[..2], b"PK");
        let parts = parts(&bytes);
        let names: Vec<&str> = parts.iter().map(|(name, _)| name.as_str()).collect();
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
        ] {
            assert!(names.contains(&required), "missing {required} in {names:?}");
        }
        for (name, xml) in &parts {
            assert_well_formed(name, xml);
        }
    }

    #[test]
    fn document_maps_markdown_to_styles_lists_and_escaped_runs() {
        let xml = document_xml(SAMPLE);
        assert!(xml.contains(r#"<w:pStyle w:val="Heading1"/>"#));
        assert!(xml.contains(r#"<w:pStyle w:val="Heading2"/>"#));
        assert!(xml.contains("Limited beta review"));
        // Bold runs from **Date:**, with the markers gone.
        assert!(xml.contains(r#"<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Date:</w:t>"#));
        assert!(!xml.contains("**"));
        // Bullets and numbers reference the two list definitions.
        assert_eq!(xml.matches(r#"<w:numId w:val="1"/>"#).count(), 2);
        assert_eq!(xml.matches(r#"<w:numId w:val="2"/>"#).count(), 2);
        // Owner and due survive inside the bullet text.
        assert!(xml.contains("(Owner: Jonathan · Due: Friday)"));
        // Escaping and inline styles.
        assert!(xml.contains("&amp; "));
        assert!(xml.contains("&lt;with&gt; &quot;angles&quot;"));
        assert!(xml.contains(r#"<w:pStyle w:val="Quote"/>"#));
        assert!(xml.contains(r#"<w:rFonts w:ascii="Courier New""#));
        assert!(xml.contains("<w:i/></w:rPr><w:t xml:space=\"preserve\">more</w:t>"));
        // The rule line is dropped; an unmatched asterisk is kept as typed.
        assert!(!xml.contains("---"));
        assert!(xml.contains("unmatched * asterisk"));
    }

    #[test]
    fn empty_markdown_is_still_a_document() {
        let bytes = markdown_to_docx("").expect("build empty docx");
        let parts = parts(&bytes);
        let document = &parts
            .iter()
            .find(|(name, _)| name == "word/document.xml")
            .expect("document part")
            .1;
        assert!(document.contains("<w:body><w:p/>"));
    }

    #[test]
    fn underscores_inside_a_word_are_not_emphasis() {
        // The regression: an identifier came out of the export in italics with
        // both underscores eaten.
        let runs = parse_runs("See file_name_here in the repo.");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "See file_name_here in the repo.");
        assert!(!runs[0].italic);

        // Emphasis at word boundaries still works, on its own and mid-sentence.
        let emphasised: Vec<(String, bool)> = parse_runs("an _emphasised_ word")
            .into_iter()
            .map(|run| (run.text, run.italic))
            .collect();
        assert_eq!(
            emphasised,
            vec![
                ("an ".to_string(), false),
                ("emphasised".to_string(), true),
                (" word".to_string(), false),
            ]
        );
        // A trailing identifier does not reopen emphasis behind it.
        let trailing = parse_runs("_start_ then snake_case_name");
        assert_eq!(
            trailing
                .iter()
                .filter(|run| run.italic)
                .map(|run| run.text.as_str())
                .collect::<Vec<_>>(),
            vec!["start"]
        );
        assert!(trailing
            .iter()
            .any(|run| run.text.contains("snake_case_name")));
    }

    #[test]
    fn unmatched_underscore_openers_are_processed_in_linear_time() {
        // Every underscore looks like an opener, but none is a valid closer.
        // Keep this large enough to catch accidental per-opener suffix scans.
        let text = "_a ".repeat(20_000);
        let runs = parse_runs(&text);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, text);
        assert!(!runs[0].italic);
    }

    #[test]
    fn xml_escaping_drops_characters_no_xml_document_may_carry() {
        let escaped = escape_xml("ok\u{0}\u{7}\u{FFFE}\u{FFFF}\tstill\nok\u{FDD0}");
        assert_eq!(escaped, "ok\tstill\nok\u{FDD0}");
        assert!(!escaped.contains('\u{FFFE}'));
        assert!(!escaped.contains('\u{FFFF}'));
    }

    #[test]
    fn inline_runs_toggle_only_with_a_partner() {
        let runs = parse_runs("a **b** c *d* `e` f_g");
        let texts: Vec<(String, bool, bool, bool)> = runs
            .into_iter()
            .map(|r| (r.text, r.bold, r.italic, r.code))
            .collect();
        assert_eq!(
            texts,
            vec![
                ("a ".to_string(), false, false, false),
                ("b".to_string(), true, false, false),
                (" c ".to_string(), false, false, false),
                ("d".to_string(), false, true, false),
                (" ".to_string(), false, false, false),
                ("e".to_string(), false, false, true),
                (" f_g".to_string(), false, false, false),
            ]
        );
    }

    /// Opens the generated file with macOS's own converter. Ignored by default
    /// because it shells out; run with `cargo test -- --ignored textutil`.
    #[test]
    #[ignore]
    fn textutil_can_read_the_generated_docx() {
        if !std::path::Path::new("/usr/bin/textutil").exists() {
            eprintln!("textutil not present; skipping");
            return;
        }
        let bytes = markdown_to_docx(SAMPLE).expect("build docx");
        let path =
            std::env::temp_dir().join(format!("plainsong-docx-{}.docx", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("write docx");
        let output = std::process::Command::new("/usr/bin/textutil")
            .args(["-convert", "txt", "-stdout"])
            .arg(&path)
            .output()
            .expect("run textutil");
        let _ = std::fs::remove_file(&path);
        assert!(output.status.success(), "textutil failed: {:?}", output);
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("Limited beta review"), "{text}");
        assert!(
            text.contains("Jonathan confirms export before beta invites."),
            "{text}"
        );
    }
}
