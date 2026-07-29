import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import {
  analyzeRecordings,
  askMemory,
  getRelationshipMemory,
  searchTranscripts,
} from "@/lib/backend/ai";
import type {
  CompanyMemoryProfile,
  MeetingChatMessage,
  PersonMemoryProfile,
  RelationshipMemory,
} from "@/lib/backend/ai";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { requestMainView, requestRecordingWorkspace } from "@/lib/navigation";
import { requestOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import {
  Folder,
  FileAudio,
  Brain,
  Loader2,
  Mic,
  Rocket,
  CheckCircle2,
  ArrowRight,
  Search,
  Send,
  Users,
} from "lucide-react";

/** m:ss for a transcript offset, so a hit reads like a place in the meeting. */
function formatHitTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${(safeSeconds % 60).toString().padStart(2, "0")}`;
}

export function DashboardView() {
  const { projects } = useProjects();
  const { recordings } = useRecordings();
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{
    recordingId: string;
    recordingTitle: string;
    projectId: string;
    segmentId: string;
    text: string;
    startTime: number;
    endTime: number;
    score: number;
  }>>([]);
  const [selectedRecordingIds, setSelectedRecordingIds] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [multiAnalysisResult, setMultiAnalysisResult] = useState<string | null>(null);
  const [multiAnalysisCitations, setMultiAnalysisCitations] = useState<Array<{
    text: string;
    startTime?: number;
    endTime?: number;
    recordingId?: string;
  }>>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryMessages, setMemoryMessages] = useState<MeetingChatMessage[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const currentRequestIdRef = useRef<number>(0);
  const [relationshipMemory, setRelationshipMemory] = useState<RelationshipMemory | null>(null);
  const [relationshipMemoryLoading, setRelationshipMemoryLoading] = useState(true);
  const [relationshipMemoryError, setRelationshipMemoryError] = useState<string | null>(null);
  const {
    dictationReady,
    meetingReady,
    fullCaptureReady,
    loading: setupLoading,
  } = useSetupStatus();

  useEffect(() => {
    let cancelled = false;

    const loadRelationshipMemory = async () => {
      setRelationshipMemoryLoading(true);
      setRelationshipMemoryError(null);
      try {
        const result = await getRelationshipMemory();
        if (!cancelled) {
          setRelationshipMemory(result);
        }
      } catch (error) {
        if (!cancelled) {
          setRelationshipMemoryError(
            error instanceof Error ? error.message : "Relationship memory could not be loaded"
          );
        }
      } finally {
        if (!cancelled) {
          setRelationshipMemoryLoading(false);
        }
      }
    };

    void loadRelationshipMemory();

    return () => {
      cancelled = true;
    };
  }, []);

  const recentRecordings = useMemo(() => recordings.slice(0, 10), [recordings]);
  const totalDuration = useMemo(() => recordings.reduce((acc, r) => acc + r.duration, 0), [recordings]);
  const setupHeadline = setupLoading
    ? "Checking your voice workspace"
    : dictationReady && meetingReady && fullCaptureReady
      ? "Everything is ready"
      : dictationReady && meetingReady
        ? "Dictation and mic-only meetings are ready"
        : dictationReady
          ? "Dictation is ready. Meetings need one more pass"
          : meetingReady
            ? "Mic-only meetings are ready. Dictation needs one more pass"
            : "Finish setup to unlock the full solo workflow";
  const timelineGroups = useMemo(() => recordings.reduce<Record<string, typeof recordings>>((acc, recording) => {
    const key = new Date(recording.createdAt).toLocaleDateString();
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(recording);
    return acc;
  }, {}), [recordings]);

  const buildThreadedMemoryQuery = (query: string) => {
    if (memoryMessages.length === 0) {
      return query;
    }

    const threadContext = memoryMessages
      .slice(-6)
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n\n");

    return [
      "Conversation so far:",
      threadContext,
      "",
      `New user question: ${query}`,
      "Answer the newest question directly. Use prior meeting transcripts as the source of truth and cite the supporting evidence.",
    ].join("\n");
  };

  const runMemoryQuery = async (queryOverride?: string) => {
    const query = (queryOverride ?? memoryQuery).trim();
    if (!query) return;
    
    const requestId = Date.now();
    currentRequestIdRef.current = requestId;
    
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await askMemory(buildThreadedMemoryQuery(query));
      
      // Check if this is still the current request
      if (currentRequestIdRef.current !== requestId) {
        return; // Abandon stale result
      }
      
      const timestamp = new Date().toISOString();
      setMemoryMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: query,
          citations: [],
          createdAt: timestamp,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.response,
          citations: result.citations,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (!queryOverride) {
        setMemoryQuery("");
      }
    } catch (error) {
      // Only update error if this is still the current request
      if (currentRequestIdRef.current === requestId) {
        setMemoryError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Only update loading state if this is still the current request
      if (currentRequestIdRef.current === requestId) {
        setMemoryLoading(false);
      }
    }
  };

  const buildRelationshipPrompt = (
    profile: PersonMemoryProfile | CompanyMemoryProfile,
    kind: "person" | "company"
  ) =>
    kind === "person"
      ? `What has ${profile.name} cared about across recent meetings? Include priorities, decisions, open questions, and next steps.`
      : `What have we learned about ${profile.name} across recent meetings? Include priorities, risks, decisions, and next steps.`;

  const runGlobalSearch = async () => {
    const query = globalQuery.trim();
    if (!query) return;
    setIsSearching(true);
    setLastSearchQuery(query);
    setAnalysisError(null);
    try {
      const hits = await searchTranscripts(query, 25);
      setSearchResults(hits);
      const uniqueIds = [...new Set(hits.map((hit) => hit.recordingId))];
      setSelectedRecordingIds(uniqueIds);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Transcript search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const runMultiRecordingAnalysis = async () => {
    if (!analysisQuery.trim() || selectedRecordingIds.length === 0) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const result = await analyzeRecordings(selectedRecordingIds, analysisQuery.trim());
      setMultiAnalysisResult(result.response);
      setMultiAnalysisCitations(result.citations);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Cross-recording analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        eyebrow="WORKSPACE"
        title="Home"
        subtitle="Dictation, meetings, and follow-through in one place"
        actions={
          <Button onClick={() => requestMainView("dictation")}>
            <Mic data-icon="inline-start" />
            Start Dictation
          </Button>
        }
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 lg:px-8">
          <section className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <Card className="surface-panel overflow-hidden xl:col-span-8">
              <CardContent className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="min-w-0">
                  <div className="mb-5 flex flex-wrap items-center gap-2">
                    {/* The one full-gold mark on Home is the CTA in the page
                        header, so readiness state is a hairline badge with a
                        neume rather than a second gilded fill. */}
                    <Badge
                      variant="outline"
                      className={
                        dictationReady && meetingReady
                          ? "border-gold/30 text-gold-text"
                          : "border-rust/30 text-rust"
                      }
                    >
                      <span
                        className={
                          dictationReady && meetingReady ? "neume neume-lit" : "neume neume-rust"
                        }
                        aria-hidden="true"
                      />
                      {setupLoading
                        ? "Checking setup"
                        : dictationReady && meetingReady && fullCaptureReady
                          ? "Ready"
                          : dictationReady && meetingReady
                            ? "Mic-only ready"
                            : "Needs attention"}
                    </Badge>
                  </div>
                  <p className="font-serif text-2xl font-semibold tracking-tight text-card-foreground sm:text-3xl">
                    {setupHeadline}
                  </p>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Dictate into whatever app you are in, record a meeting, then search back through
                    everything that was said.
                  </p>
                  <div className="mt-6 flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => requestMainView("dictation")}>
                      <Mic data-icon="inline-start" />
                      Open dictation
                    </Button>
                    <Button variant="outline" onClick={() => requestMainView("recordings")}>
                      <FileAudio data-icon="inline-start" />
                      Open meetings
                    </Button>
                    <Button variant="ghost" onClick={() => requestMainView("setup")}>
                      <Rocket data-icon="inline-start" />
                      Setup
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
                  {[
                    {
                      label: "Dictation",
                      ready: dictationReady,
                      action: () =>
                        dictationReady ? requestMainView("dictation") : requestOnboarding("dictation"),
                    },
                    {
                      label: "Meetings",
                      ready: meetingReady,
                      action: () =>
                        meetingReady ? requestMainView("recordings") : requestOnboarding("meetings"),
                    },
                    { label: "Local memory", ready: true, action: () => requestMainView("settings") },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="command-card flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left"
                      onClick={item.action}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-card-foreground">{item.label}</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          {item.ready ? "Open" : "Review"}
                        </span>
                      </span>
                      {item.ready ? (
                        <ArrowRight className="h-4 w-4 shrink-0 text-gold-text" />
                      ) : (
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="surface-panel-subtle xl:col-span-4">
              <CardContent className="flex h-full flex-col gap-4 p-5">
                <h2 className="section-heading">Stored on this Mac</h2>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xl font-semibold tabular-nums">{recordings.length}</p>
                    <p className="mt-1 text-sm text-muted-foreground">Recordings</p>
                  </div>
                  <div>
                    <p className="text-xl font-semibold tabular-nums">{projects.length}</p>
                    <p className="mt-1 text-sm text-muted-foreground">Projects</p>
                  </div>
                  <div>
                    <p className="text-xl font-semibold tabular-nums">{Math.floor(totalDuration / 3600)}h</p>
                    <p className="mt-1 text-sm text-muted-foreground">Audio</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  <Brain className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  Ask your meetings
                </CardTitle>
                {memoryMessages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => {
                      setMemoryMessages([]);
                      setMemoryError(null);
                    }}
                  >
                    Clear thread
                  </Button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                A question in plain words. The answer comes back with the lines from your
                transcripts it was based on.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={memoryQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setMemoryQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runMemoryQuery(); }}
                  placeholder="Ask about your meetings..."
                />
                <Button
                  aria-label="Send"
                  onClick={() => void runMemoryQuery()}
                  disabled={memoryLoading || !memoryQuery.trim()}
                >
                  {memoryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              {memoryError && (
                <div className="rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust">
                  {memoryError}
                </div>
              )}
              {memoryMessages.length > 0 && (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {memoryMessages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "p-3 rounded-lg",
                        message.role === "user" ? "bg-muted/40 ml-8" : "bg-muted/20 mr-8"
                      )}
                    >
                      <p className="text-sm">{message.content}</p>
                      {message.citations && message.citations.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {message.citations.map((citation, idx) => (
                            <div key={idx} className="border-l-2 border-gold/30 pl-2 text-sm text-muted-foreground">
                              {citation.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Relationship Memory
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Who keeps coming up, gathered from speaker names and transcripts on this Mac.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {relationshipMemoryError ? (
                <p className="text-sm text-destructive">{relationshipMemoryError}</p>
              ) : null}
              {relationshipMemoryLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Reading your transcripts…
                </div>
              ) : null}
              {!relationshipMemoryLoading &&
              !relationshipMemoryError &&
              relationshipMemory &&
              relationshipMemory.people.length === 0 &&
              relationshipMemory.companies.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Name the speakers in a meeting or two and the people you meet with will appear here.
                </p>
              ) : null}
              {!relationshipMemoryLoading && relationshipMemory ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-2">
                      <h3 className="section-heading">People</h3>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {relationshipMemory.people.length}
                      </span>
                    </div>
                    {relationshipMemory.people.slice(0, 4).map((person) => (
                      <div key={person.id} className="space-y-2 border-t border-border/40 pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{person.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {person.recordingCount} meetings · last seen{" "}
                              {new Date(person.lastSeenAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() => void runMemoryQuery(buildRelationshipPrompt(person, "person"))}
                            disabled={memoryLoading}
                          >
                            Ask
                          </Button>
                        </div>
                        {person.relatedCompanies.length > 0 ? (
                          <p className="text-sm text-muted-foreground">
                            Also in meetings with {person.relatedCompanies.join(", ")}
                          </p>
                        ) : null}
                        {person.recentMeetings[0] ? (
                          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{person.recentMeetings[0].snippet}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-2">
                      <h3 className="section-heading">Companies</h3>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {relationshipMemory.companies.length}
                      </span>
                    </div>
                    {relationshipMemory.companies.slice(0, 4).map((company) => (
                      <div key={company.id} className="space-y-2 border-t border-border/40 pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{company.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {company.recordingCount} meetings · last seen{" "}
                              {new Date(company.lastSeenAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() => void runMemoryQuery(buildRelationshipPrompt(company, "company"))}
                            disabled={memoryLoading}
                          >
                            Ask
                          </Button>
                        </div>
                        {company.relatedPeople.length > 0 ? (
                          <p className="text-sm text-muted-foreground">
                            Also in meetings with {company.relatedPeople.join(", ")}
                          </p>
                        ) : null}
                        {company.recentMeetings[0] ? (
                          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{company.recentMeetings[0].snippet}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Search across meetings
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Word-for-word search over every transcript. Open a result to jump to that moment,
                or tick results and ask one question across all of them.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={globalQuery}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setGlobalQuery(event.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runGlobalSearch(); }}
                  placeholder="Search every transcript…"
                  className="bg-muted/30"
                />
                <Button onClick={runGlobalSearch} disabled={isSearching || !globalQuery.trim()}>
                  {isSearching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                  Search
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-2">
                  {/* Two jobs, two controls: the checkbox picks meetings for
                      cross-meeting analysis, the row opens the meeting at the
                      moment the hit was found. Previously a hit could only
                      toggle the checkbox and never opened anything. */}
                  {searchResults.map((hit) => {
                    const isSelected = selectedRecordingIds.includes(hit.recordingId);
                    return (
                      <div
                        key={`${hit.recordingId}-${hit.segmentId}`}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md transition-colors",
                          isSelected ? "border border-primary/20 bg-primary/10" : "border border-transparent"
                        )}
                      >
                        <button
                          type="button"
                          aria-label={`Include ${hit.recordingTitle} in cross-meeting analysis`}
                          aria-pressed={isSelected}
                          className="mt-2 ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            setSelectedRecordingIds((prev) => {
                              if (isSelected) {
                                return prev.filter((id) => id !== hit.recordingId);
                              }
                              return [...new Set([...prev, hit.recordingId])];
                            });
                          }}
                        >
                          <span className={cn(
                            "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                            isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"
                          )}>
                            {isSelected && <CheckCircle2 className="h-3 w-3" />}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="min-w-0 flex-1 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() =>
                            requestRecordingWorkspace({
                              recordingId: hit.recordingId,
                              focusSegmentTime: hit.startTime,
                              highlightQuery: lastSearchQuery,
                            })
                          }
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="truncate font-medium">{hit.recordingTitle}</span>
                            <span className="rubric-muted time-spec shrink-0">
                              {formatHitTimestamp(hit.startTime)}
                            </span>
                          </span>
                          <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">
                            {hit.text}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {lastSearchQuery && !isSearching && searchResults.length === 0 && !analysisError ? (
                <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3 text-sm text-muted-foreground">
                  No transcript matches for "{lastSearchQuery}". Try a person, company, topic, or exact phrase from a meeting.
                </div>
              ) : null}

              <Separator />

              <div className="flex gap-2">
                <Input
                  value={analysisQuery}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setAnalysisQuery(event.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && selectedRecordingIds.length > 0) void runMultiRecordingAnalysis(); }}
                  placeholder="What changed across these meetings?"
                  className="bg-muted/30"
                />
                <Button
                  onClick={runMultiRecordingAnalysis}
                  disabled={isAnalyzing || !analysisQuery.trim() || selectedRecordingIds.length === 0}
                >
                  {isAnalyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Analyze
                </Button>
              </div>
              {selectedRecordingIds.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Search transcripts first, then select one or more matching meetings to analyze.
                </p>
              ) : null}

              {analysisError && (
                <p className="text-sm text-rust">{analysisError}</p>
              )}

              {multiAnalysisResult && (
                <div className="space-y-2 rounded-lg border-l-2 border-l-gold/40 bg-muted/20 p-4 text-sm">
                  <p className="whitespace-pre-wrap leading-relaxed">{multiAnalysisResult}</p>
                  {multiAnalysisCitations.length > 0 && (
                    <div className="mt-3 space-y-1 border-t border-border/50 pt-3">
                      {multiAnalysisCitations.map((citation, index) => (
                        <p key={index} className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {recordings.find((recording) => recording.id === citation.recordingId)
                              ?.title ?? "This meeting"}
                          </span>{" "}
                          <span className="time-spec">
                            {formatHitTimestamp(citation.startTime ?? 0)}
                          </span>
                          {": "}
                          {citation.text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Tabs defaultValue="recent" className="space-y-4">
            <TabsList>
              <TabsTrigger value="recent">Recent</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="timeline">By day</TabsTrigger>
            </TabsList>

            <TabsContent value="recent" className="space-y-4">
              {recentRecordings.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <span className="neume neume-hollow" />
                  <p className="font-serif text-base font-medium">Nothing recorded yet</p>
                  <p className="text-sm text-muted-foreground">Recordings show up here as you make them.</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {recentRecordings.map((recording) => (
                    <button
                      type="button"
                      key={recording.id}
                      onClick={() => requestMainView("recordings")}
                      className="group flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50 cursor-pointer"
                    >
                      <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{recording.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge variant="secondary" className="time-spec shrink-0">
                        {Math.floor(recording.duration / 60)}:{(recording.duration % 60).toString().padStart(2, '0')}
                      </Badge>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="projects" className="space-y-4">
              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <span className="neume neume-hollow" />
                  <p className="font-serif text-base font-medium">No projects yet</p>
                  <p className="text-sm text-muted-foreground">Create one to file dictation somewhere of its own.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {projects.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      onClick={() => requestMainView("projects")}
                      className="rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Card variant="interactive" className="h-full">
                        <CardHeader className="pb-2">
                          <div className="flex items-center gap-2">
                            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <CardTitle className="truncate text-base">{project.name}</CardTitle>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="line-clamp-2 text-sm text-muted-foreground">
                            {project.description || "No description"}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Created {new Date(project.createdAt).toLocaleDateString()}
                          </p>
                        </CardContent>
                      </Card>
                    </button>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="timeline">
              {Object.keys(timelineGroups).length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <span className="neume neume-hollow" />
                  <p className="font-serif text-base font-medium">Nothing recorded yet</p>
                  <p className="text-sm text-muted-foreground">Recordings group themselves by day once you have some.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(timelineGroups).map(([date, items]) => (
                    <div key={date}>
                      <p className="rubric-muted mb-2">{date}</p>
                      <div className="space-y-1">
                        {items.map((recording) => (
                          <div key={recording.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                            <span className="truncate font-medium">{recording.title}</span>
                            <span className="time-spec shrink-0 text-xs text-muted-foreground">
                              {new Date(recording.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}
