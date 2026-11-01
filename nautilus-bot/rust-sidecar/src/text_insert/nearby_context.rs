//! Read only the original window's visible AX nodes, without clipboard or keys.
use super::*;
use crate::dictation_screen_context::{self as context, NearbyTextReader, Vocabulary};
use core_foundation_sys::array::{
    CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
};
use core_foundation_sys::base::CFRetain;
use core_foundation_sys::string::{CFStringGetCharacters, CFStringGetLength};
use std::collections::HashSet;
use std::time::Instant;

extern "C" {
    fn AXUIElementCopyAttributeValues(
        element: AXUIElementRef,
        attribute: CFStringRef,
        index: isize,
        max_values: isize,
        values: *mut CFArrayRef,
    ) -> AXError;
}

struct Node(CFTypeRef);
impl Drop for Node {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.0);
        }
    }
}

struct Reader<'a> {
    expected: &'a DeliveryFieldFingerprint,
    valid: &'a dyn Fn() -> bool,
    seen: HashSet<u64>,
    frame: Option<(f64, f64, f64, f64)>,
}

fn copy(node: &Node, attribute: &str, end: Instant) -> Option<Node> {
    if !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let value = ax_copy_attribute_value(node.0, attribute).ok()??;
    let value = Node(value);
    (Instant::now() < end).then_some(value)
}

fn children_array(node: &Node, attribute: &str, limit: usize, end: Instant) -> Option<Node> {
    if limit == 0 || !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let attribute = ax_attribute(attribute);
    let mut array = std::ptr::null();
    let error = unsafe {
        AXUIElementCopyAttributeValues(
            node.0,
            attribute.as_concrete_TypeRef(),
            0,
            limit as isize,
            &mut array,
        )
    };
    if array.is_null() {
        return None;
    }
    let array = Node(array.cast());
    (error == AX_ERROR_SUCCESS && Instant::now() < end).then_some(array)
}

fn string(value: Node, cap: usize) -> Option<String> {
    if unsafe { CFGetTypeID(value.0) != CFStringGetTypeID() } {
        return None;
    }
    let count = usize::try_from(unsafe { CFStringGetLength(value.0.cast()) })
        .ok()?
        .min(cap);
    let mut units = vec![0u16; count];
    unsafe {
        CFStringGetCharacters(
            value.0.cast(),
            CFRange {
                location: 0,
                length: count as isize,
            },
            units.as_mut_ptr(),
        );
    }
    // A cut surrogate is discarded, never replaced with invented text.
    if units
        .last()
        .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
    {
        units.pop();
    }
    String::from_utf16(&units).ok()
}

fn attr(node: &Node, name: &str, cap: usize, end: Instant) -> Option<String> {
    string(copy(node, name, end)?, cap)
}

fn safe(node: &Node, end: Instant) -> Option<String> {
    let role = attr(node, "AXRole", 64, end)?;
    if !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let subrole = ax_copy_attribute_value(node.0, "AXSubrole")
        .ok()?
        .map(Node)
        .and_then(|value| string(value, 64));
    if dictation_secure_field::classify_secure_field(
        Some(&role),
        subrole.as_deref(),
        secure_event_input_enabled(),
    )
    .is_some()
    {
        return None;
    }
    if !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let hidden = ax_copy_boolean_attribute(node.0, "AXHidden").ok()?;
    if hidden == Some(true) || Instant::now() >= end {
        return None;
    }
    Some(role)
}

fn frame(node: &Node, end: Instant) -> Option<(f64, f64, f64, f64)> {
    if !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let (x, y) = ax_copy_cg_pair_attribute(node.0, "AXPosition", AX_VALUE_CG_POINT_TYPE)?;
    if !selected_context_read::messaging_timeout(node.0, end) {
        return None;
    }
    let (w, h) = ax_copy_cg_pair_attribute(node.0, "AXSize", AX_VALUE_CG_SIZE_TYPE)?;
    (w > 0.0 && h > 0.0 && [x, y, w, h].iter().all(|v| v.is_finite())).then_some((x, y, w, h))
}

impl NearbyTextReader for Reader<'_> {
    type Node = Node;
    fn roots(&mut self, end: Instant) -> Vec<Node> {
        if !(self.valid)() {
            return vec![];
        }
        let Some(pid) = self.expected.pid else {
            return vec![];
        };
        if !check_accessibility_permission() || secure_event_input_enabled() {
            return vec![];
        }
        let app = Node(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            std::mem::forget(app);
            return vec![];
        }
        let Some(frontmost) = copy(&app, "AXFrontmost", end) else {
            return vec![];
        };
        if unsafe {
            CFGetTypeID(frontmost.0) != CFBoolean::type_id()
                || !core_foundation_sys::number::CFBooleanGetValue(frontmost.0.cast())
        } {
            return vec![];
        }
        let Some(focus) = copy(&app, "AXFocusedUIElement", end) else {
            return vec![];
        };
        if self.expected.element_hash
            != Some(unsafe { core_foundation_sys::base::CFHash(focus.0) } as u64)
            || safe(&focus, end).as_deref() != self.expected.role.as_deref()
        {
            return vec![];
        }
        let Some(window) = copy(&focus, "AXWindow", end) else {
            return vec![];
        };
        if safe(&window, end).is_none() {
            return vec![];
        }
        if attr(&window, "AXTitle", 256, end)
            .is_some_and(|title| context::denied_app(Some(&title), None))
        {
            return vec![];
        }
        self.frame = frame(&window, end);
        if self.frame.is_none() {
            return vec![];
        }
        // Closest container first, then window headers. Never traverse AXParent
        // during the walk, so another window or application cannot enter it.
        let mut roots = vec![];
        if let Some(parent) = copy(&focus, "AXParent", end) {
            let parent_window = copy(&parent, "AXWindow", end);
            let same_window =
                unsafe { core_foundation_sys::base::CFEqual(parent.0, window.0) != 0 }
                    || parent_window.as_ref().is_some_and(|value| unsafe {
                        core_foundation_sys::base::CFEqual(value.0, window.0) != 0
                    });
            if same_window {
                roots.push(parent);
            }
        }
        roots.push(window);
        roots
    }
    fn visible_text(&mut self, node: &Node, remaining: usize, end: Instant) -> Option<String> {
        if !(self.valid)() {
            return None;
        }
        if !self
            .seen
            .insert(unsafe { core_foundation_sys::base::CFHash(node.0) } as u64)
        {
            return None;
        }
        let role = safe(node, end)?;
        if let Some((wx, wy, ww, wh)) = self.frame {
            let (x, y, w, h) = frame(node, end)?;
            if x >= wx + ww || y >= wy + wh || x + w <= wx || y + h <= wy {
                return None;
            }
        }
        let mut text = String::new();
        for attribute in ["AXTitle", "AXDescription"] {
            if let Some(value) = attr(
                node,
                attribute,
                remaining.saturating_sub(text.chars().count()),
                end,
            ) {
                text.push_str(&value);
                if text.chars().count() < remaining {
                    text.push('\n');
                }
            }
        }
        let cap = remaining.saturating_sub(text.chars().count());
        if cap > 0 && matches!(role.as_str(), "AXStaticText" | "AXTextField" | "AXComboBox") {
            if let Some(value) = attr(node, "AXValue", cap, end) {
                text.push_str(&value);
            }
        }
        // Large documents/code fields expose their visible range separately.
        // Do not request AXValue, which could copy the entire document.
        if cap > 0 && role == "AXTextArea" && selected_context_read::messaging_timeout(node.0, end)
        {
            if let Ok(Some(mut range)) =
                ax_copy_cf_range_attribute(node.0, "AXVisibleCharacterRange")
            {
                if range.location >= 0
                    && range.length > 0
                    && selected_context_read::messaging_timeout(node.0, end)
                {
                    range.length = range.length.min(cap as isize);
                    let parameter = unsafe {
                        AXValueCreate(
                            AX_VALUE_CF_RANGE_TYPE,
                            &range as *const CFRange as *const std::ffi::c_void,
                        )
                    };
                    if !parameter.is_null() {
                        let parameter = Node(parameter);
                        let attribute = ax_attribute("AXStringForRange");
                        let mut value = std::ptr::null();
                        let error = unsafe {
                            AXUIElementCopyParameterizedAttributeValue(
                                node.0,
                                attribute.as_concrete_TypeRef(),
                                parameter.0,
                                &mut value,
                            )
                        };
                        if !value.is_null() {
                            let value = Node(value);
                            if error == AX_ERROR_SUCCESS {
                                if let Some(value) = string(value, cap) {
                                    text.push_str(&value);
                                }
                            }
                        }
                    }
                }
            }
        }
        (Instant::now() < end).then_some(text)
    }
    fn children(&mut self, node: &Node, limit: usize, end: Instant) -> Vec<Node> {
        if !(self.valid)() {
            return vec![];
        }
        let Some(array) = children_array(node, "AXVisibleChildren", limit, end)
            .or_else(|| children_array(node, "AXChildren", limit, end))
        else {
            return vec![];
        };
        if unsafe { CFGetTypeID(array.0) != CFArrayGetTypeID() } {
            return vec![];
        }
        let count = unsafe { CFArrayGetCount(array.0.cast()) }.max(0) as usize;
        (0..count.min(limit))
            .map(|index| {
                let value = unsafe { CFArrayGetValueAtIndex(array.0.cast(), index as isize) };
                Node(unsafe { CFRetain(value) })
            })
            .collect()
    }
}

pub(crate) fn capture(
    expected: &DeliveryFieldFingerprint,
    valid: &impl Fn() -> bool,
) -> Vocabulary {
    if context::denied_app(
        expected.app_name.as_deref(),
        expected.app_bundle_id.as_deref(),
    ) {
        return Vocabulary::default();
    }
    context::read_vocabulary(
        &mut Reader {
            expected,
            valid,
            seen: HashSet::new(),
            frame: None,
        },
        Instant::now() + context::READ_BUDGET,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reports Accessibility permission for this exact test executable"]
    fn native_screen_permission_probe() {
        assert_eq!(
            std::env::var("PLAINSONG_QA_NEARBY_TEXTEDIT").as_deref(),
            Ok("1")
        );
        println!(
            "NEARBY_AX_PERMISSION: trusted={}",
            check_accessibility_permission()
        );
    }

    /// Run only with an agent-created, frontmost TextEdit fixture. No keys,
    /// clipboard, profile, permission requests or text insertion are used here.
    #[test]
    #[ignore = "requires a throwaway frontmost TextEdit document and Accessibility permission"]
    fn native_textedit_context_probe() {
        assert_eq!(
            std::env::var("PLAINSONG_QA_NEARBY_TEXTEDIT").as_deref(),
            Ok("1")
        );
        if !check_accessibility_permission() {
            println!(
                "NEARBY_AX_BLOCKED: Accessibility permission unavailable to this test candidate"
            );
            return;
        }
        assert_eq!(get_frontmost_app_name().as_deref(), Some("TextEdit"));
        let field =
            capture_focused_field_fingerprint_without_activation().expect("TextEdit focused field");
        assert_eq!(field.app_bundle_id.as_deref(), Some("com.apple.TextEdit"));
        let expected_pid = std::env::var("PLAINSONG_QA_NEARBY_TEXTEDIT_PID")
            .expect("task-owned TextEdit PID")
            .parse::<i32>()
            .expect("valid TextEdit PID");
        assert_eq!(field.pid, Some(expected_pid));
        for sample in 0..5 {
            let focused = Node(
                copy_frontmost_focused_accessibility_element(
                    Some("TextEdit"),
                    Some("com.apple.TextEdit"),
                )
                .expect("TextEdit Accessibility query")
                .expect("TextEdit focused field"),
            );
            let end = Instant::now() + std::time::Duration::from_millis(500);
            let window = copy(&focused, "AXWindow", end).expect("TextEdit fixture window");
            let title = attr(&window, "AXTitle", 256, end)
                .expect("disposable fixture window title could not be read");
            assert!(
                title.starts_with("Plainsong Nearby Spelling"),
                "native probe requires the disposable fixture window"
            );
            let began = Instant::now();
            let vocabulary = capture(&field, &|| true);
            let elapsed = began.elapsed();
            let (corrected, applied) = context::correct(
                "Ask Jonathon Reed, not Prishma, for 12 reports.",
                &vocabulary,
                &[],
                false,
            );
            println!("NEARBY_AX_RESULT: sample={sample} read_and_extraction_us={} terms={vocabulary:?} applied={}", elapsed.as_micros(), applied.len());
            assert_eq!(corrected, "Ask Jonathan Reed, not Prishma, for 12 reports.");
        }
    }
}
