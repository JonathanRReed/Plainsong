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
import { requestMainView } from "@/lib/navigation";
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
  Building2,
  Zap,
} from "lucide-react";

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
  const { dictationReady, meetingReady, loading: setupLoading } = useSetupStatus();

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
    : dictationReady && meetingReady
      ? "Everything is ready"
      : dictationReady
        ? "Dictation is ready. Meetings need one more pass"
        : meetingReady
          ? "Meetings are ready. Dictation needs one more pass"
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
    if (!globalQuery.trim()) return;
    setIsSearching(true);
    setAnalysisError(null);
    try {
      const hits = await searchTranscripts(globalQuery.trim(), 25);
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
                    <Badge variant={dictationReady && meetingReady ? "default" : "destructive"}>
                      {setupLoading ? "Checking setup" : dictationReady && meetingReady ? "Ready" : "Needs attention"}
                    </Badge>
                    <Badge variant="outline">Local memory</Badge>
                  </div>
                  <p className="text-2xl font-semibold tracking-tight text-card-foreground sm:text-3xl">
                    {setupHeadline}
                  </p>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Capture voice, review the result, and move the next action forward without leaving the workspace.
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
                    { label: "Dictation", ready: dictationReady, action: () => requestOnboarding("dictation") },
                    { label: "Meetings", ready: meetingReady, action: () => requestOnboarding("meetings") },
                    { label: "Local memory", ready: true, action: () => requestMainView("settings") },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="command-card flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left"
                      onClick={item.ready ? undefined : item.action}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-card-foreground">{item.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.ready ? "Ready" : "Review"}
                        </span>
                      </span>
                      {item.ready ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-gold-text" />
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
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="rubric-muted">Today</p>
                    <p className="mt-1 font-serif text-lg font-semibold tracking-tight">Capture overview</p>
                  </div>
                  <div className="flex size-10 items-center justify-center rounded-xl bg-muted/30 text-muted-foreground">
                    <Brain className="h-4 w-4" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-border/60 bg-background/55 p-3">
                    <p className="text-xl font-semibold tabular-nums">{recordings.length}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Meetings</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/55 p-3">
                    <p className="text-xl font-semibold tabular-nums">{projects.length}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Projects</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/55 p-3">
                    <p className="text-xl font-semibold tabular-nums">{Math.floor(totalDuration / 3600)}h</p>
                    <p className="mt-1 text-xs text-muted-foreground">Audio</p>
                  </div>
                </div>
                <Separator />
                <div className="flex items-start gap-3 rounded-xl bg-muted/35 p-3">
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm leading-6 text-muted-foreground">
                    Dictation stays first. Meetings add memory, action items, and follow-through.
                  </p>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Second Brain - Memory */}
          <Card className="hover-lift">
            <CardHeader>
              <p className="rubric mb-1.5">MEMORY</p>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 font-serif">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/30">
                    <Brain className="h-4 w-4 text-muted-foreground" />
                  </div>
                  Second Brain
                </CardTitle>
                {memoryMessages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground"
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
                Ask anything across your meetings. Answers with citations from local transcripts.
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
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
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
                            <div key={idx} className="text-xs text-muted-foreground border-l-2 border-gold/30 pl-2">
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

          <Card className="hover-lift">
            <CardHeader>
              <p className="rubric mb-1.5">PEOPLE & COMPANIES</p>
              <CardTitle className="flex items-center gap-2 font-serif">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/30">
                  <Users className="h-4 w-4 text-muted-foreground" />
                </div>
                Relationship Memory
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Local memory built from speaker names, notes, and transcripts.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {relationshipMemoryError ? (
                <p className="text-sm text-destructive">{relationshipMemoryError}</p>
              ) : null}
              {relationshipMemoryLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Building local relationship memory…
                </div>
              ) : null}
              {!relationshipMemoryLoading &&
              !relationshipMemoryError &&
              relationshipMemory &&
              relationshipMemory.people.length === 0 &&
              relationshipMemory.companies.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Record more meetings or name speakers to build people and company memory.
                </p>
              ) : null}
              {!relationshipMemoryLoading && relationshipMemory ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                        <Users className="h-3 w-3" />
                        People
                      </h3>
                      <Badge variant="secondary" className="text-[10px]">
                        {relationshipMemory.people.length}
                      </Badge>
                    </div>
                    {relationshipMemory.people.slice(0, 4).map((person) => (
                      <div key={person.id} className="rounded-lg border bg-muted/10 p-3 space-y-2 transition-colors hover:bg-muted/20">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{person.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {person.recordingCount} meetings · last seen{" "}
                              {new Date(person.lastSeenAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 text-xs"
                            onClick={() => void runMemoryQuery(buildRelationshipPrompt(person, "person"))}
                            disabled={memoryLoading}
                          >
                            Ask
                          </Button>
                        </div>
                        {person.relatedCompanies.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Related: {person.relatedCompanies.join(", ")}
                          </p>
                        ) : null}
                        {person.recentMeetings[0] ? (
                          <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">{person.recentMeetings[0].snippet}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                        <Building2 className="h-3 w-3" />
                        Companies
                      </h3>
                      <Badge variant="secondary" className="text-[10px]">
                        {relationshipMemory.companies.length}
                      </Badge>
                    </div>
                    {relationshipMemory.companies.slice(0, 4).map((company) => (
                      <div key={company.id} className="rounded-lg border bg-muted/10 p-3 space-y-2 transition-colors hover:bg-muted/20">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{company.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {company.recordingCount} meetings · last seen{" "}
                              {new Date(company.lastSeenAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 text-xs"
                            onClick={() => void runMemoryQuery(buildRelationshipPrompt(company, "company"))}
                            disabled={memoryLoading}
                          >
                            Ask
                          </Button>
                        </div>
                        {company.relatedPeople.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Related: {company.relatedPeople.join(", ")}
                          </p>
                        ) : null}
                        {company.recentMeetings[0] ? (
                          <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">{company.recentMeetings[0].snippet}</p>
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
              <p className="rubric mb-1.5">SEARCH</p>
              <CardTitle className="flex items-center gap-2 font-serif">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/20">
                  <Search className="h-4 w-4 text-muted-foreground" />
                </div>
                Ask Across Meetings
              </CardTitle>
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
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-2">
                  {searchResults.map((hit) => {
                    const isSelected = selectedRecordingIds.includes(hit.recordingId);
                    return (
                      <button
                        type="button"
                        key={`${hit.recordingId}-${hit.segmentId}`}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                          isSelected ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/40"
                        )}
                        onClick={() => {
                          setSelectedRecordingIds((prev) => {
                            if (isSelected) {
                              return prev.filter((id) => id !== hit.recordingId);
                            }
                            return [...new Set([...prev, hit.recordingId])];
                          });
                        }}
                      >
                        <div className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                          isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"
                        )}>
                          {isSelected && <CheckCircle2 className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{hit.recordingTitle}</p>
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {hit.startTime.toFixed(1)}s–{hit.endTime.toFixed(1)}s · {hit.text}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

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

              {analysisError && (
                <p className="text-sm text-destructive">{analysisError}</p>
              )}

              {multiAnalysisResult && (
                <div className="space-y-2 rounded-lg border-l-2 border-l-gold/40 bg-muted/20 p-4 text-sm">
                  <p className="whitespace-pre-wrap leading-relaxed">{multiAnalysisResult}</p>
                  {multiAnalysisCitations.length > 0 && (
                    <div className="mt-3 space-y-1 border-t border-border/50 pt-3">
                      {multiAnalysisCitations.map((citation, index) => (
                        <p key={index} className="text-xs text-muted-foreground">
                          [{citation.recordingId ?? "recording"}] {citation.startTime?.toFixed(1)}s–{citation.endTime?.toFixed(1)}s: {citation.text}
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
              <TabsTrigger value="recent">Recent Sessions</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            <TabsContent value="recent" className="space-y-4">
              {recentRecordings.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <span className="neume neume-hollow" />
                  <p className="font-serif text-base font-medium">No meetings yet</p>
                  <p className="text-sm text-muted-foreground">Start recording to see them here.</p>
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
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                        <FileAudio className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{recording.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-xs tabular-nums">
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
                  <p className="text-sm text-muted-foreground">Create your first project to organize meetings.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {projects.map((project) => (
                    <Card
                      key={project.id}
                      onClick={() => requestMainView("projects")}
                      className="group cursor-pointer transition-colors hover:border-primary/30"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/20">
                            <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <CardTitle className="text-base truncate">{project.name}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {project.description || "No description"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">
                          Created {new Date(project.createdAt).toLocaleDateString()}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="timeline">
              {Object.keys(timelineGroups).length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <span className="neume neume-hollow" />
                  <p className="font-serif text-base font-medium">No timeline yet</p>
                  <p className="text-sm text-muted-foreground">Sessions will appear here as they are captured.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(timelineGroups).map(([date, items]) => (
                    <div key={date}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{date}</p>
                      <div className="space-y-1">
                        {items.map((recording) => (
                          <div key={recording.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                            <span className="truncate font-medium">{recording.title}</span>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
