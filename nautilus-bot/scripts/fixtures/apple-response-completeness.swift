#if canImport(FoundationModels)
if #available(macOS 26.0, *) {
  let complete = try GeneratedContent(json: "{\"answer\":\"Ready.\",\"lineIds\":[\"L1\"]}")
  try requireCompleteResponse(complete)
  try requireCompleteResponse(GeneratedContent(json: "\"Ready.\""))
  for input in ["{\"answer\":\"Cut", "{\"answer\":\"Ready.\"", "\"Cut"] {
    let content = try GeneratedContent(json: input)
    guard !content.isComplete else {
      fputs("FAIL: fixture must be incomplete\n", stderr)
      exit(1)
    }
    do {
      try requireCompleteResponse(content)
    } catch {
      guard classify(error) == .outputLimit else {
        fputs("FAIL: incomplete content must report output_limit\n", stderr)
        exit(1)
      }
      continue
    }
    fputs("FAIL: helper accepted incomplete content as a completed response\n", stderr)
    exit(1)
  }
  print("{\"result\":\"passed\",\"cases\":5,\"modelGeneration\":false}")
} else {
  print("{\"result\":\"skipped\",\"reason\":\"requires macOS 26\"}")
}
#else
print("{\"result\":\"skipped\",\"reason\":\"Foundation Models unavailable in SDK\"}")
#endif
