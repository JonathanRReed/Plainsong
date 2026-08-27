import EventKit
import Foundation

// Read-only EventKit probe for Plainsong's calendar-aware meeting capture.
//
// Three things this helper deliberately does NOT do:
//
//  1. It never writes to a calendar. There is no EKEvent construction, no
//     `save`, no `remove` — the only store call that touches events is
//     `events(matching:)`.
//  2. It never prompts unless it is told to. `--probe` and `--events` read
//     `EKEventStore.authorizationStatus(for:)`, which is documented not to
//     prompt; only `--request-access` calls a request API. Electron reaches
//     that mode from exactly one command, which itself requires a user gesture,
//     so calendar access can never be asked for on launch.
//  3. It never emits calendar prose. Titles are the feature, so they are
//     emitted whole. Locations and notes are not: they are run through
//     NSDataDetector and only the URL-shaped matches leave this process. A
//     "budget review with $NAME at $ADDRESS" note therefore contributes a Zoom
//     link and nothing else.
//
// Classification of those URLs into a service ("this is a Zoom call") happens
// in the Electron main process rather than here, so the host table can be
// corrected without recompiling and re-signing a native binary — and so it can
// be unit tested.

private let protocolVersion = 1

/// ~8 hours, the window the Meetings header affordance reads from.
private let defaultHorizonMinutes = 480
private let maximumHorizonMinutes = 24 * 60
private let maximumEvents = 50
private let maximumConferenceUrlsPerEvent = 4
private let maximumConferenceUrlLength = 512
private let authorizationTimeoutSeconds = 60

private enum HelperErrorCode: String {
  case authorizationDenied = "authorization_denied"
  case authorizationNotDetermined = "authorization_not_determined"
  case authorizationRestricted = "authorization_restricted"
  case authorizationWriteOnly = "authorization_write_only"
  case malformedRequest = "malformed_request"
  case storeUnavailable = "store_unavailable"
  case timeout = "timeout"
}

private struct ErrorPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let code: String
  let message: String
  let retryable: Bool
  let authorization: String
}

private struct CalendarPayload: Encodable {
  let id: String
  let title: String
  let accountName: String
}

private struct EventPayload: Encodable {
  let id: String
  let title: String
  let startsAt: String
  let endsAt: String
  let isAllDay: Bool
  let calendarId: String
  let calendarName: String
  let conferenceUrls: [String]
}

private struct ProbePayload: Encodable {
  let protocolVersion: Int
  let type: String
  let authorization: String
  let authorizationCode: Int
  let operatingSystemVersion: String
}

private struct EventsPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let authorization: String
  let observedAt: String
  let horizonMinutes: Int
  let calendars: [CalendarPayload]
  let events: [EventPayload]
}

private let encoder: JSONEncoder = {
  let encoder = JSONEncoder()
  encoder.keyEncodingStrategy = .convertToSnakeCase
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return encoder
}()

private let isoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  formatter.timeZone = TimeZone(secondsFromGMT: 0)
  return formatter
}()

private func emit<T: Encodable>(_ payload: T) {
  guard let data = try? encoder.encode(payload) else {
    // Encoding a fixed-shape struct cannot realistically fail, but a silent
    // empty stdout would read to the caller as "helper produced nothing".
    FileHandle.standardOutput.write(
      Data(
        #"{"protocol_version":1,"type":"error","code":"store_unavailable","message":"Could not encode the calendar response.","retryable":false,"authorization":"unknown"}"#
          .utf8
      )
    )
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(1)
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

private func fail(
  _ code: HelperErrorCode,
  _ message: String,
  retryable: Bool,
  authorization: String
) -> Never {
  emit(
    ErrorPayload(
      protocolVersion: protocolVersion,
      type: "error",
      code: code.rawValue,
      message: message,
      retryable: retryable,
      authorization: authorization
    )
  )
  exit(1)
}

// MARK: - Authorization

/// The TCC state, reported by raw value.
///
/// macOS 14 renamed `.authorized` to `.fullAccess` and added `.writeOnly`, and
/// the renamed cases are annotated `@available(macOS 14.0, *)`. Reading the raw
/// value keeps one code path for both the macOS 13 floor the app supports and
/// the macOS 14+ SDK it is compiled against, and the numbers are ABI, not
/// spelling: 0 notDetermined, 1 restricted, 2 denied, 3 authorized/fullAccess,
/// 4 writeOnly.
///
/// `writeOnly` is reported distinctly rather than folded into "denied": an app
/// that may add events but not read them is a different fix in System Settings,
/// and calling it denied would send the reader to the wrong switch.
private func authorizationName(_ status: EKAuthorizationStatus) -> String {
  switch status.rawValue {
  case 0: return "not_determined"
  case 1: return "restricted"
  case 2: return "denied"
  case 3: return "authorized"
  case 4: return "write_only"
  default: return "unknown"
  }
}

private func currentAuthorization() -> EKAuthorizationStatus {
  EKEventStore.authorizationStatus(for: .event)
}

private func operatingSystemVersion() -> String {
  let version = ProcessInfo.processInfo.operatingSystemVersion
  return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
}

private func probePayload(_ status: EKAuthorizationStatus) -> ProbePayload {
  ProbePayload(
    protocolVersion: protocolVersion,
    type: "probe",
    authorization: authorizationName(status),
    authorizationCode: Int(status.rawValue),
    operatingSystemVersion: operatingSystemVersion()
  )
}

/// The ONLY code path in this helper that can raise a TCC prompt.
private func requestAccess() -> EKAuthorizationStatus {
  let existing = currentAuthorization()
  // Asking again after an answer re-prompts nothing; macOS returns the stored
  // decision immediately. Returning early keeps that explicit.
  if existing != .notDetermined {
    return existing
  }

  let store = EKEventStore()
  let semaphore = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { _, _ in semaphore.signal() }
  } else {
    store.requestAccess(to: .event) { _, _ in semaphore.signal() }
  }

  if semaphore.wait(timeout: .now() + .seconds(authorizationTimeoutSeconds)) == .timedOut {
    fail(
      .timeout,
      "Timed out waiting for the macOS calendar permission response.",
      retryable: true,
      authorization: authorizationName(currentAuthorization())
    )
  }

  // The granted flag and the stored status can disagree while the prompt is
  // being dismissed; the stored status is the one every later run reads.
  return currentAuthorization()
}

// MARK: - Events

private let linkDetector = try? NSDataDetector(
  types: NSTextCheckingResult.CheckingType.link.rawValue
)

/// URL-shaped substrings of the fields a conferencing link hides in.
///
/// Everything else in `location` and `notes` is discarded here, inside the
/// helper, so prose from a calendar note never crosses into the app.
///
/// Restricted to http/https because NSDataDetector happily matches any scheme:
/// a Contacts-backed birthday event carries `addressbook://<person-uuid>` in
/// its URL field, and that is a pointer into the address book, not a
/// conferencing link. No video service is reachable over a non-web scheme, so
/// the filter costs nothing and stops a whole class of local identifiers from
/// leaving the helper.
private func conferenceUrls(for event: EKEvent) -> [String] {
  var found: [String] = []
  var seen = Set<String>()

  func consider(_ candidate: String?) {
    guard let candidate, !candidate.isEmpty, found.count < maximumConferenceUrlsPerEvent else {
      return
    }
    guard let detector = linkDetector else { return }
    let range = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
    detector.enumerateMatches(in: candidate, options: [], range: range) { match, _, stop in
      guard let url = match?.url else { return }
      let scheme = url.scheme?.lowercased()
      guard scheme == "http" || scheme == "https" else { return }
      let text = url.absoluteString
      guard text.count <= maximumConferenceUrlLength, !seen.contains(text) else { return }
      seen.insert(text)
      found.append(text)
      if found.count >= maximumConferenceUrlsPerEvent {
        stop.pointee = true
      }
    }
  }

  consider(event.url?.absoluteString)
  consider(event.location)
  consider(event.notes)
  return found
}

/// Whether the current user has said no to this invitation.
///
/// A declined meeting is still on the calendar and would otherwise be offered
/// as "starts in 12 min — Start capture", which is the one suggestion the
/// reader has already explicitly refused.
private func currentUserDeclined(_ event: EKEvent) -> Bool {
  guard let attendees = event.attendees else { return false }
  return attendees.contains { $0.isCurrentUser && $0.participantStatus == .declined }
}

private func eventPayload(_ event: EKEvent) -> EventPayload? {
  guard let start = event.startDate, let end = event.endDate else { return nil }
  guard let calendar = event.calendar else { return nil }
  let title = (event.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  guard !title.isEmpty else { return nil }
  guard event.status != .canceled, !currentUserDeclined(event) else { return nil }

  // `eventIdentifier` is empty for some subscribed/birthday events; a stable
  // fallback keeps React keys and the dismissal list working.
  let identifier = event.eventIdentifier?.isEmpty == false
    ? event.eventIdentifier!
    : "\(calendar.calendarIdentifier):\(isoFormatter.string(from: start)):\(title)"

  return EventPayload(
    id: identifier,
    title: title,
    startsAt: isoFormatter.string(from: start),
    endsAt: isoFormatter.string(from: end),
    isAllDay: event.isAllDay,
    calendarId: calendar.calendarIdentifier,
    calendarName: calendar.title,
    conferenceUrls: conferenceUrls(for: event)
  )
}

private func loadEvents(horizonMinutes: Int) -> EventsPayload {
  let status = currentAuthorization()
  let name = authorizationName(status)
  switch status.rawValue {
  case 0:
    fail(
      .authorizationNotDetermined,
      "Plainsong has not been given calendar access yet.",
      retryable: true,
      authorization: name
    )
  case 1:
    fail(
      .authorizationRestricted,
      "Calendar access is restricted on this Mac.",
      retryable: false,
      authorization: name
    )
  case 2:
    fail(
      .authorizationDenied,
      "Calendar access is turned off for Plainsong.",
      retryable: false,
      authorization: name
    )
  case 4:
    fail(
      .authorizationWriteOnly,
      "Plainsong may add calendar events but not read them.",
      retryable: false,
      authorization: name
    )
  default:
    break
  }

  let store = EKEventStore()
  let calendars = store.calendars(for: .event)
  let now = Date()
  // The window starts at the beginning of today rather than at `now` so an
  // in-progress meeting is still returned; the caller decides what to do with
  // one that has already started.
  let startOfDay = Calendar.current.startOfDay(for: now)
  let end = now.addingTimeInterval(TimeInterval(horizonMinutes * 60))
  let predicate = store.predicateForEvents(
    withStart: startOfDay,
    end: end,
    calendars: calendars.isEmpty ? nil : calendars
  )
  let events = store.events(matching: predicate)
    .compactMap(eventPayload)
    .sorted { $0.startsAt < $1.startsAt }
    .prefix(maximumEvents)

  return EventsPayload(
    protocolVersion: protocolVersion,
    type: "events",
    authorization: name,
    observedAt: isoFormatter.string(from: now),
    horizonMinutes: horizonMinutes,
    calendars: calendars
      .map {
        CalendarPayload(
          id: $0.calendarIdentifier,
          title: $0.title,
          accountName: $0.source?.title ?? ""
        )
      }
      .sorted { $0.title < $1.title },
    events: Array(events)
  )
}

// MARK: - Entry point

private func integerArgument(_ name: String, in arguments: [String]) -> Int? {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
    return nil
  }
  return Int(arguments[index + 1])
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--probe") {
  emit(probePayload(currentAuthorization()))
  exit(0)
}

if arguments.contains("--request-access") {
  emit(probePayload(requestAccess()))
  exit(0)
}

if arguments.contains("--events") {
  let requested = integerArgument("--horizon-minutes", in: arguments) ?? defaultHorizonMinutes
  guard requested > 0, requested <= maximumHorizonMinutes else {
    fail(
      .malformedRequest,
      "--horizon-minutes must be between 1 and \(maximumHorizonMinutes).",
      retryable: false,
      authorization: authorizationName(currentAuthorization())
    )
  }
  emit(loadEvents(horizonMinutes: requested))
  exit(0)
}

fail(
  .malformedRequest,
  "Expected one of --probe, --request-access or --events.",
  retryable: false,
  authorization: authorizationName(currentAuthorization())
)
