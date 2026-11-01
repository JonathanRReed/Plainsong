//! Capture of the sound playing on this Mac through a Core Audio process tap.
//!
//! The meeting's other side reaches the Mac as audio that an app (Zoom, Teams,
//! a browser tab, FaceTime) plays. A *global* tap (`initStereoGlobalTapButExclude
//! Processes:` with an empty exclusion list) receives every process's output
//! before it reaches any particular output device. That property is what makes
//! headphones work: the tap does not care whether the meeting app plays to the
//! built-in speakers, wired headphones, AirPods or a USB headset, and the user's
//! choice of output can change mid-meeting without the tap losing the call.
//!
//! The earlier native route bound the tap to the *default output device*. It
//! missed a meeting app that plays to a non-default device, it had to be torn
//! down whenever the default output changed, and it refused duplex outputs
//! (AirPods and most headsets) outright. A global tap has no device at all, so
//! there is no physical microphone anywhere in its aggregate device either.
//!
//! The tap sits alone in a private aggregate device; an IOProc on that
//! aggregate delivers interleaved Float32 frames in the tap's own format
//! (normally 48 kHz stereo). macOS gates the stream on the "System Audio
//! Recording" permission (TCC service `kTCCServiceAudioCapture`), attributed to
//! the responsible process, i.e. Plainsong.app. A denied permission is not an
//! error: the tap simply delivers zeros, which is why readiness also consults
//! [`audio_capture_permission`] and the meeting monitor watches for silence.
//!
//! `AudioHardwareCreateProcessTap` and `AudioHardwareDestroyProcessTap` exist
//! only on macOS 14.2+, and the sidecar must still launch on the macOS 13
//! floor, so both are resolved at runtime with `dlsym` (the vendored CPAL patch
//! does the same) rather than linked.

use std::ffi::{c_void, CStr};
use std::fmt;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, kAudioTapPropertyFormat,
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareDestroyAggregateDevice,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
    CATapMuteBehavior,
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM,
    AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

/// `kAudioDevicePermissionsError` ('!hog'): Core Audio's answer when the
/// process may not use the object, which is what a denied capture permission
/// looks like on the property calls that do report it.
const AUDIO_DEVICE_PERMISSIONS_ERROR: i32 = 0x2168_6f67;

/// What a tap records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TapScope {
    /// Everything every app plays, whichever output device it plays to.
    AllApps,
    /// Only this process's own output, muted at the hardware. Used by the
    /// system-audio check so its verification tone is never heard.
    OwnProcessMuted,
}

/// The tap's stream format, as Core Audio reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TapFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TapError {
    /// The running macOS has no process-tap API (before 14.2).
    Unsupported,
    /// macOS refused the capture permission on a call that reports it.
    PermissionDenied(String),
    /// A Core Audio call failed for another reason.
    Os { stage: &'static str, status: i32 },
    /// The tap reported a format this reader does not decode.
    UnsupportedFormat(String),
}

impl fmt::Display for TapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => {
                formatter.write_str("Core Audio process taps require macOS 14.2 or later")
            }
            Self::PermissionDenied(stage) => {
                write!(formatter, "macOS denied system-audio recording ({stage})")
            }
            Self::Os { stage, status } => {
                write!(formatter, "{stage} failed with Core Audio status {status}")
            }
            Self::UnsupportedFormat(detail) => {
                write!(
                    formatter,
                    "the system-audio tap reported an unsupported format: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for TapError {}

fn check(stage: &'static str, status: i32) -> Result<(), TapError> {
    match status {
        0 => Ok(()),
        AUDIO_DEVICE_PERMISSIONS_ERROR => Err(TapError::PermissionDenied(stage.to_string())),
        status => Err(TapError::Os { stage, status }),
    }
}

type CreateProcessTap =
    unsafe extern "C-unwind" fn(Option<&CATapDescription>, *mut AudioObjectID) -> i32;
type DestroyProcessTap = unsafe extern "C-unwind" fn(AudioObjectID) -> i32;

unsafe fn core_audio_symbol<T: Copy>(name: &'static CStr) -> Option<T> {
    let pointer = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
    if pointer.is_null() {
        None
    } else {
        Some(std::mem::transmute_copy(&pointer))
    }
}

fn create_process_tap_fn() -> Option<CreateProcessTap> {
    static FUNCTION: OnceLock<Option<CreateProcessTap>> = OnceLock::new();
    *FUNCTION.get_or_init(|| unsafe { core_audio_symbol(c"AudioHardwareCreateProcessTap") })
}

fn destroy_process_tap_fn() -> Option<DestroyProcessTap> {
    static FUNCTION: OnceLock<Option<DestroyProcessTap>> = OnceLock::new();
    *FUNCTION.get_or_init(|| unsafe { core_audio_symbol(c"AudioHardwareDestroyProcessTap") })
}

/// True when this macOS exposes the process-tap API at all.
pub(crate) fn process_taps_available() -> bool {
    create_process_tap_fn().is_some() && destroy_process_tap_fn().is_some()
}

fn property_address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn own_process_object() -> Result<AudioObjectID, TapError> {
    let address = property_address(kAudioHardwarePropertyTranslatePIDToProcessObject);
    let pid: i32 = std::process::id() as i32;
    let mut object: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&address),
            std::mem::size_of::<i32>() as u32,
            (&pid as *const i32).cast(),
            NonNull::from(&mut size),
            NonNull::from(&mut object).cast(),
        )
    };
    check("Looking up this process's audio object", status)?;
    if object == 0 {
        // A process becomes an audio object only once it has started audio IO.
        return Err(TapError::Os {
            stage: "Looking up this process's audio object",
            status: -1,
        });
    }
    Ok(object)
}

fn tap_format(tap_id: AudioObjectID) -> Result<TapFormat, TapError> {
    let address = property_address(kAudioTapPropertyFormat);
    let mut description = AudioStreamBasicDescription {
        mSampleRate: 0.0,
        mFormatID: 0,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: 0,
        mBytesPerFrame: 0,
        mChannelsPerFrame: 0,
        mBitsPerChannel: 0,
        mReserved: 0,
    };
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            tap_id,
            NonNull::from(&address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut description).cast(),
        )
    };
    check("Reading the system-audio tap format", status)?;
    validate_tap_format(&description)
}

fn validate_tap_format(description: &AudioStreamBasicDescription) -> Result<TapFormat, TapError> {
    let is_float32 = description.mFormatID == kAudioFormatLinearPCM
        && description.mFormatFlags & kAudioFormatFlagIsFloat != 0
        && description.mBitsPerChannel == 32;
    let interleaved = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0;
    let sample_rate = description.mSampleRate.round();
    if !is_float32
        || !interleaved
        || description.mChannelsPerFrame == 0
        || description.mChannelsPerFrame > u16::MAX as u32
        || !(8_000.0..=384_000.0).contains(&sample_rate)
    {
        return Err(TapError::UnsupportedFormat(format!(
            "format {:#x}, flags {:#x}, {} bits, {} ch, {} Hz",
            description.mFormatID,
            description.mFormatFlags,
            description.mBitsPerChannel,
            description.mChannelsPerFrame,
            description.mSampleRate
        )));
    }
    Ok(TapFormat {
        sample_rate: sample_rate as u32,
        channels: description.mChannelsPerFrame as u16,
    })
}

/// Receives one IO cycle's interleaved Float32 samples and the channel count.
pub(crate) type TapCallback = Box<dyn FnMut(&[f32], usize) + Send>;

/// The realtime half: Core Audio calls [`tap_io_proc`] with this as client data.
///
/// Teardown and the IO thread meet here. [`TapCallbackState::close`] runs
/// before any Core Audio object is stopped or destroyed, and after it returns
/// the user callback never runs again: the IO thread checks `closed` before it
/// touches the callback, and checks it again under the lock, so a cycle that
/// was already past the first check either finished before `close` took the
/// lock or sees `closed` once it gets in. The state itself is only freed once
/// Core Audio has confirmed the IOProc is gone (see [`tear_down`]); until then a
/// late cycle may still read `closed`, so the memory has to stay valid.
struct TapCallbackState {
    callback: std::sync::Mutex<TapCallback>,
    poisoned: AtomicBool,
    closed: AtomicBool,
}

impl TapCallbackState {
    fn new(callback: TapCallback) -> Self {
        Self {
            callback: std::sync::Mutex::new(callback),
            poisoned: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }
    }

    /// Hand one IO cycle to the user callback. False when nothing ran: the
    /// tap is closed, poisoned, or being closed right now.
    fn deliver(&self, samples: &[f32], channels: usize) -> bool {
        if self.closed.load(Ordering::SeqCst) || self.poisoned.load(Ordering::Relaxed) {
            return false;
        }
        // try_lock: the callback is only ever invoked from this one IO thread,
        // so contention means teardown is in progress; dropping one buffer
        // then is correct.
        let Ok(mut callback) = self.callback.try_lock() else {
            return false;
        };
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        (callback)(samples, channels);
        true
    }

    /// Stop the user callback for good. Waits for a cycle already inside it,
    /// then drops it, so whatever it captured (the capture queue, counters) is
    /// released even when the state itself has to be leaked.
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let mut callback = match self.callback.lock() {
            Ok(callback) => callback,
            Err(poisoned) => poisoned.into_inner(),
        };
        *callback = Box::new(|_, _| {});
    }
}

unsafe extern "C-unwind" fn tap_io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input_data: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output_data: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client_data: *mut c_void,
) -> i32 {
    if client_data.is_null() {
        return 0;
    }
    let state = &*(client_data as *const TapCallbackState);
    if state.closed.load(Ordering::SeqCst) || state.poisoned.load(Ordering::Relaxed) {
        return 0;
    }
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let list = input_data.as_ref();
        let buffers =
            std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize);
        // The aggregate holds exactly one tap, so its input is one interleaved
        // buffer. Anything else would be a different device than we built.
        let Some(buffer) = buffers.first() else {
            return;
        };
        if buffer.mData.is_null() || buffer.mNumberChannels == 0 {
            return;
        }
        let samples = std::slice::from_raw_parts(
            buffer.mData as *const f32,
            buffer.mDataByteSize as usize / std::mem::size_of::<f32>(),
        );
        state.deliver(samples, buffer.mNumberChannels as usize);
    }));
    if outcome.is_err() {
        state.poisoned.store(true, Ordering::Relaxed);
        tracing::error!("System-audio tap callback panicked; this capture stream is now inert");
    }
    0
}

/// The Core Audio calls teardown makes, behind a seam so the ownership rule
/// in [`tear_down`] can be tested with failures injected. Each returns the
/// call's `OSStatus`.
trait TapTeardownOps {
    fn stop_io(&mut self) -> i32;
    fn destroy_io_proc(&mut self) -> i32;
    fn destroy_aggregate(&mut self) -> i32;
    fn destroy_tap(&mut self) -> i32;
}

/// What teardown may do with the callback state afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallbackStateDisposal {
    /// Core Audio confirmed IO stopped and the IOProc is gone: nothing can
    /// call into the state again.
    Free,
    /// Core Audio did not confirm that, so a late IO cycle could still read
    /// the state. Leaking a few bytes is the safe answer; freeing would be a
    /// use-after-free.
    Leak,
}

/// Tear down a tap and decide whether its callback state may be freed.
///
/// The callback is closed first, so even when a Core Audio call fails no user
/// code runs after this. Every remaining object is still destroyed on a best
/// effort basis, and every failure is logged.
fn tear_down(
    ops: &mut impl TapTeardownOps,
    running: bool,
    state: &TapCallbackState,
) -> CallbackStateDisposal {
    state.close();
    let stop_status = if running { ops.stop_io() } else { 0 };
    if stop_status != 0 {
        tracing::error!(
            "Stopping the system-audio reader failed with Core Audio status {stop_status}"
        );
    }
    let io_proc_status = ops.destroy_io_proc();
    if io_proc_status != 0 {
        tracing::error!(
            "Removing the system-audio reader failed with Core Audio status {io_proc_status}"
        );
    }
    let aggregate_status = ops.destroy_aggregate();
    if aggregate_status != 0 {
        tracing::warn!(
            "Destroying the system-audio aggregate device failed with Core Audio status {aggregate_status}"
        );
    }
    let tap_status = ops.destroy_tap();
    if tap_status != 0 {
        tracing::warn!(
            "Destroying the system-audio tap failed with Core Audio status {tap_status}"
        );
    }
    if stop_status == 0 && io_proc_status == 0 {
        CallbackStateDisposal::Free
    } else {
        tracing::error!(
            "Keeping the system-audio callback state alive because Core Audio did not confirm the reader was removed"
        );
        CallbackStateDisposal::Leak
    }
}

struct CoreAudioTeardown {
    tap_id: AudioObjectID,
    aggregate_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
}

impl TapTeardownOps for CoreAudioTeardown {
    fn stop_io(&mut self) -> i32 {
        unsafe { AudioDeviceStop(self.aggregate_id, self.io_proc_id) }
    }

    fn destroy_io_proc(&mut self) -> i32 {
        // Destroying the IOProc waits for an in-flight callback.
        unsafe { AudioDeviceDestroyIOProcID(self.aggregate_id, self.io_proc_id) }
    }

    fn destroy_aggregate(&mut self) -> i32 {
        unsafe { AudioHardwareDestroyAggregateDevice(self.aggregate_id) }
    }

    fn destroy_tap(&mut self) -> i32 {
        match destroy_process_tap_fn() {
            Some(destroy) => unsafe { destroy(self.tap_id) },
            None => 0,
        }
    }
}

static AGGREGATE_COUNTER: AtomicU32 = AtomicU32::new(0);

/// One running (or ready-to-run) process tap and the private aggregate device
/// that reads it. Dropping it stops IO and destroys both Core Audio objects.
pub(crate) struct SystemOutputTap {
    tap_id: AudioObjectID,
    aggregate_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
    state: *mut TapCallbackState,
    format: TapFormat,
    running: bool,
    // Keep the description alive for the tap's lifetime.
    _description: Retained<CATapDescription>,
}

// The raw pointers are owned by this struct and only touched by Core Audio's
// IO thread (through the IOProc) and by Drop, which stops IO first.
unsafe impl Send for SystemOutputTap {}

impl SystemOutputTap {
    /// Create the tap and its aggregate device without starting IO.
    ///
    /// `callback` receives interleaved Float32 samples and the channel count.
    pub(crate) fn create(scope: TapScope, callback: TapCallback) -> Result<Self, TapError> {
        let create_tap = create_process_tap_fn().ok_or(TapError::Unsupported)?;
        if destroy_process_tap_fn().is_none() {
            return Err(TapError::Unsupported);
        }

        let description = unsafe {
            match scope {
                TapScope::AllApps => CATapDescription::initStereoGlobalTapButExcludeProcesses(
                    CATapDescription::alloc(),
                    &NSArray::new(),
                ),
                TapScope::OwnProcessMuted => {
                    let object = own_process_object()?;
                    let processes =
                        NSArray::from_retained_slice(&[NSNumber::numberWithUnsignedInt(object)]);
                    let description = CATapDescription::initStereoMixdownOfProcesses(
                        CATapDescription::alloc(),
                        &processes,
                    );
                    description.setMuteBehavior(CATapMuteBehavior::Muted);
                    description
                }
            }
        };
        let pid = std::process::id();
        let instance = AGGREGATE_COUNTER.fetch_add(1, Ordering::Relaxed);
        unsafe {
            description.setPrivate(true);
            description.setName(&NSString::from_str(&format!(
                "Plainsong meeting audio {pid}.{instance}"
            )));
        }

        let mut tap_id: AudioObjectID = 0;
        let status = unsafe { create_tap(Some(&description), &mut tap_id) };
        check("Creating the system-audio tap", status)?;

        // From here on, every early return must destroy what exists so far.
        let mut partial = PartialTap {
            tap_id,
            aggregate_id: 0,
        };

        let format = tap_format(tap_id)?;
        let tap_uuid = unsafe { description.UUID().UUIDString() }.to_string();
        let aggregate_uid = format!("app.plainsong.meeting-audio.{pid}.{instance}");
        let properties = aggregate_properties(&tap_uuid, &aggregate_uid, pid, instance);

        let mut aggregate_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                &*(properties.as_concrete_TypeRef() as *const objc2_core_foundation::CFDictionary),
                NonNull::from(&mut aggregate_id),
            )
        };
        check("Creating the system-audio aggregate device", status)?;
        partial.aggregate_id = aggregate_id;

        let state = Box::into_raw(Box::new(TapCallbackState::new(callback)));
        let mut io_proc_id: AudioDeviceIOProcID = None;
        let status = unsafe {
            AudioDeviceCreateIOProcID(
                aggregate_id,
                Some(tap_io_proc),
                state.cast(),
                NonNull::from(&mut io_proc_id),
            )
        };
        if let Err(error) = check("Registering the system-audio reader", status) {
            drop(unsafe { Box::from_raw(state) });
            return Err(error);
        }

        partial.disarm();
        Ok(Self {
            tap_id,
            aggregate_id,
            io_proc_id,
            state,
            format,
            running: false,
            _description: description,
        })
    }

    pub(crate) fn format(&self) -> TapFormat {
        self.format
    }

    /// Re-read the tap's format. False when it no longer matches what this
    /// reader was built for, so the caller can reopen the route with a fresh
    /// rate converter. A read failure counts as unchanged: a transient property
    /// error must not tear down a working capture.
    pub(crate) fn format_unchanged(&self) -> bool {
        tap_format(self.tap_id).map_or(true, |format| format == self.format)
    }

    /// Start IO. The first start in a process that has never been granted
    /// the permission is what makes macOS show its prompt; this call can block
    /// while the prompt is unanswered.
    pub(crate) fn start(&mut self) -> Result<(), TapError> {
        if self.running {
            return Ok(());
        }
        let status = unsafe { AudioDeviceStart(self.aggregate_id, self.io_proc_id) };
        check("Starting the system-audio reader", status)?;
        self.running = true;
        Ok(())
    }
}

impl Drop for SystemOutputTap {
    fn drop(&mut self) {
        let mut ops = CoreAudioTeardown {
            tap_id: self.tap_id,
            aggregate_id: self.aggregate_id,
            io_proc_id: self.io_proc_id,
        };
        // SAFETY: `state` came from `Box::into_raw` in `create` and is only
        // freed below, once.
        let disposal = tear_down(&mut ops, self.running, unsafe { &*self.state });
        if disposal == CallbackStateDisposal::Free {
            drop(unsafe { Box::from_raw(self.state) });
        }
    }
}

/// Destroys a half-built tap on an early return from [`SystemOutputTap::create`].
struct PartialTap {
    tap_id: AudioObjectID,
    aggregate_id: AudioObjectID,
}

impl PartialTap {
    fn disarm(&mut self) {
        self.tap_id = 0;
        self.aggregate_id = 0;
    }
}

impl Drop for PartialTap {
    fn drop(&mut self) {
        unsafe {
            if self.aggregate_id != 0 {
                let _ = AudioHardwareDestroyAggregateDevice(self.aggregate_id);
            }
            if self.tap_id != 0 {
                if let Some(destroy) = destroy_process_tap_fn() {
                    let _ = destroy(self.tap_id);
                }
            }
        }
    }
}

fn cf_key(key: &CStr) -> CFString {
    CFString::new(key.to_str().unwrap_or_default())
}

/// A private, tap-only aggregate device. No hardware sub-device is listed, so
/// the aggregate has no physical input that could ever open a microphone.
fn aggregate_properties(
    tap_uuid: &str,
    aggregate_uid: &str,
    pid: u32,
    instance: u32,
) -> CFDictionary<CFString, CFType> {
    let sub_tap = CFDictionary::<CFString, CFType>::from_CFType_pairs(&[
        (
            cf_key(kAudioSubTapUIDKey),
            CFString::new(tap_uuid).as_CFType(),
        ),
        (
            cf_key(kAudioSubTapDriftCompensationKey),
            CFBoolean::true_value().as_CFType(),
        ),
    ]);
    let taps = CFArray::from_CFTypes(&[sub_tap]);
    CFDictionary::from_CFType_pairs(&[
        (
            cf_key(kAudioAggregateDeviceNameKey),
            CFString::new(&format!("Plainsong meeting audio {pid}.{instance}")).as_CFType(),
        ),
        (
            cf_key(kAudioAggregateDeviceUIDKey),
            CFString::new(aggregate_uid).as_CFType(),
        ),
        (
            cf_key(kAudioAggregateDeviceIsPrivateKey),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            cf_key(kAudioAggregateDeviceTapAutoStartKey),
            CFBoolean::true_value().as_CFType(),
        ),
        (cf_key(kAudioAggregateDeviceTapListKey), taps.as_CFType()),
    ])
}

/// What macOS has recorded for Plainsong's "System Audio Recording" permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioCapturePermission {
    Granted,
    Denied,
    /// Never asked. Starting a tap will show the macOS prompt.
    NotDetermined,
    /// The status could not be read on this macOS.
    Unknown,
}

pub(crate) fn permission_from_preflight(result: Option<i32>) -> AudioCapturePermission {
    match result {
        Some(0) => AudioCapturePermission::Granted,
        Some(1) => AudioCapturePermission::Denied,
        Some(2) => AudioCapturePermission::NotDetermined,
        _ => AudioCapturePermission::Unknown,
    }
}

/// Read, without prompting, whether Plainsong may record system audio.
///
/// Apple publishes no API for this permission. `TCCAccessPreflight` is the
/// read-only TCC call the open-source AudioCap sample uses for the same
/// purpose; it never shows UI and never changes the setting. It is resolved
/// at runtime so a macOS that drops it degrades to [`AudioCapturePermission::
/// Unknown`], and callers then fall back to the in-session check instead of
/// trusting it.
pub(crate) fn audio_capture_permission() -> AudioCapturePermission {
    type Preflight = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
    static PREFLIGHT: OnceLock<Option<Preflight>> = OnceLock::new();
    let preflight = *PREFLIGHT.get_or_init(|| unsafe {
        let handle = libc::dlopen(
            c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
            libc::RTLD_NOW | libc::RTLD_LOCAL,
        );
        if handle.is_null() {
            return None;
        }
        let symbol = libc::dlsym(handle, c"TCCAccessPreflight".as_ptr());
        (!symbol.is_null()).then(|| std::mem::transmute::<*mut c_void, Preflight>(symbol))
    });
    let Some(preflight) = preflight else {
        return AudioCapturePermission::Unknown;
    };
    let service = CFString::from_static_string("kTCCServiceAudioCapture");
    let result = unsafe {
        preflight(
            service.as_concrete_TypeRef() as *const c_void,
            std::ptr::null(),
        )
    };
    permission_from_preflight(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn description(
        format_id: u32,
        flags: u32,
        bits: u32,
        channels: u32,
        rate: f64,
    ) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription {
            mSampleRate: rate,
            mFormatID: format_id,
            mFormatFlags: flags,
            mBytesPerPacket: 0,
            mFramesPerPacket: 1,
            mBytesPerFrame: 0,
            mChannelsPerFrame: channels,
            mBitsPerChannel: bits,
            mReserved: 0,
        }
    }

    #[test]
    fn tap_format_accepts_interleaved_float32_at_any_device_rate() {
        // 9 = float | packed, which is what a 48 kHz global tap reports.
        for rate in [16_000.0, 24_000.0, 44_100.0, 48_000.0, 96_000.0] {
            let format =
                validate_tap_format(&description(kAudioFormatLinearPCM, 9, 32, 2, rate)).unwrap();
            assert_eq!(format.sample_rate, rate as u32);
            assert_eq!(format.channels, 2);
        }
    }

    #[test]
    fn tap_format_rejects_layouts_the_reader_would_misread() {
        let non_interleaved = kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved;
        for bad in [
            description(kAudioFormatLinearPCM, non_interleaved, 32, 2, 48_000.0),
            description(kAudioFormatLinearPCM, 0x4, 16, 2, 48_000.0),
            description(kAudioFormatLinearPCM, 9, 32, 0, 48_000.0),
            description(kAudioFormatLinearPCM, 9, 32, 2, 0.0),
            description(0x6161_6320, 9, 32, 2, 48_000.0),
        ] {
            assert!(matches!(
                validate_tap_format(&bad),
                Err(TapError::UnsupportedFormat(_))
            ));
        }
    }

    #[test]
    fn preflight_codes_map_to_permission_states() {
        assert_eq!(
            permission_from_preflight(Some(0)),
            AudioCapturePermission::Granted
        );
        assert_eq!(
            permission_from_preflight(Some(1)),
            AudioCapturePermission::Denied
        );
        assert_eq!(
            permission_from_preflight(Some(2)),
            AudioCapturePermission::NotDetermined
        );
        assert_eq!(
            permission_from_preflight(Some(7)),
            AudioCapturePermission::Unknown
        );
        assert_eq!(
            permission_from_preflight(None),
            AudioCapturePermission::Unknown
        );
    }

    #[derive(Default)]
    struct FakeTeardown {
        stop: i32,
        io_proc: i32,
        aggregate: i32,
        tap: i32,
        calls: Vec<&'static str>,
    }

    impl TapTeardownOps for FakeTeardown {
        fn stop_io(&mut self) -> i32 {
            self.calls.push("stop");
            self.stop
        }
        fn destroy_io_proc(&mut self) -> i32 {
            self.calls.push("io_proc");
            self.io_proc
        }
        fn destroy_aggregate(&mut self) -> i32 {
            self.calls.push("aggregate");
            self.aggregate
        }
        fn destroy_tap(&mut self) -> i32 {
            self.calls.push("tap");
            self.tap
        }
    }

    fn counting_state() -> (TapCallbackState, std::sync::Arc<AtomicU32>) {
        let count = std::sync::Arc::new(AtomicU32::new(0));
        let seen = std::sync::Arc::clone(&count);
        let state = TapCallbackState::new(Box::new(move |_, _| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        (state, count)
    }

    #[test]
    fn callback_state_is_freed_only_after_core_audio_confirms_the_reader_is_gone() {
        let cases = [
            // (running, stop, io_proc, aggregate, tap, expected)
            (true, 0, 0, 0, 0, CallbackStateDisposal::Free),
            (false, -1, 0, 0, 0, CallbackStateDisposal::Free),
            (true, 0, 0, -50, -50, CallbackStateDisposal::Free),
            (true, -50, 0, 0, 0, CallbackStateDisposal::Leak),
            (true, 0, -50, 0, 0, CallbackStateDisposal::Leak),
            (false, 0, -50, 0, 0, CallbackStateDisposal::Leak),
            (true, -50, -50, -50, -50, CallbackStateDisposal::Leak),
        ];
        for (running, stop, io_proc, aggregate, tap, expected) in cases {
            let mut ops = FakeTeardown {
                stop,
                io_proc,
                aggregate,
                tap,
                ..FakeTeardown::default()
            };
            let (state, _) = counting_state();
            assert_eq!(
                tear_down(&mut ops, running, &state),
                expected,
                "running={running} stop={stop} io_proc={io_proc} aggregate={aggregate} tap={tap}"
            );
            // Every object is still torn down, whatever failed before it.
            let mut expected_calls = vec!["io_proc", "aggregate", "tap"];
            if running {
                expected_calls.insert(0, "stop");
            }
            assert_eq!(ops.calls, expected_calls);
        }
    }

    #[test]
    fn no_callback_runs_after_teardown_even_when_the_state_is_leaked() {
        let (state, count) = counting_state();
        assert!(state.deliver(&[0.1, 0.1], 2));
        assert_eq!(count.load(Ordering::SeqCst), 1);

        let mut ops = FakeTeardown {
            io_proc: -50,
            ..FakeTeardown::default()
        };
        assert_eq!(
            tear_down(&mut ops, true, &state),
            CallbackStateDisposal::Leak
        );
        // A late IO cycle on the leaked state reads `closed` and goes no
        // further, and the user callback's captures were already released.
        assert!(!state.deliver(&[0.1, 0.1], 2));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(std::sync::Arc::strong_count(&count), 1);
    }

    #[test]
    fn closing_waits_for_a_cycle_already_inside_the_callback() {
        use std::sync::mpsc;
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let state = std::sync::Arc::new(TapCallbackState::new(Box::new(move |_, _| {
            let _ = entered_tx.send(());
            let _ = release_rx.lock().unwrap().recv();
        })));

        let io_state = std::sync::Arc::clone(&state);
        let io_thread = std::thread::spawn(move || io_state.deliver(&[0.2], 1));
        entered_rx.recv().unwrap();

        let closed = std::sync::Arc::new(AtomicBool::new(false));
        let close_state = std::sync::Arc::clone(&state);
        let close_flag = std::sync::Arc::clone(&closed);
        let closer = std::thread::spawn(move || {
            close_state.close();
            close_flag.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !closed.load(Ordering::SeqCst),
            "close returned while a cycle was still inside the callback"
        );
        release_tx.send(()).unwrap();
        assert!(io_thread.join().unwrap());
        closer.join().unwrap();
        assert!(closed.load(Ordering::SeqCst));
        assert!(!state.deliver(&[0.2], 1));
    }

    #[test]
    fn permission_errors_are_told_apart_from_other_failures() {
        assert!(matches!(
            check("stage", AUDIO_DEVICE_PERMISSIONS_ERROR),
            Err(TapError::PermissionDenied(_))
        ));
        assert!(matches!(
            check("stage", -50),
            Err(TapError::Os { status: -50, .. })
        ));
        assert!(check("stage", 0).is_ok());
    }
}
