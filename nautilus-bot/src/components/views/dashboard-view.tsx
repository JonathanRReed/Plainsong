import { useEffect, useMemo, useState, type ChangeEvent } from "react";
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
import { validateLicense } from "@/lib/backend/license";
import type {
  CompanyMemoryProfile,
  MeetingChatMessage,
  PersonMemoryProfile,
  RelationshipMemory,
} from "@/lib/backend/ai";
import type { LicenseInfo } from "@/lib/backend/license";
import { deriveEntitlement } from "@/hooks/use-license-features";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { requestMainView } from "@/lib/navigation";
import { requestOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import {
  Folder,
  FileAudio,
  Clock,
  Brain,
  Loader2,
  Mic,
  Rocket,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Search,
  Send,
  Users,
  Building2,
  Zap,
} from "lucide-react";
import { AnimatedGradientText } from "@/components/ui/animated-gradient-text";
import { TierBadge } from "@/components/tier-badge";

const QUICK_STATS = [
  {
    label: "Projects",
    icon: Folder,
    accentClass: "bg-primary/10 text-primary",
  },
  {
    label: "Meetings",
    icon: FileAudio,
    accentClass: "bg-info/10 text-info",
  },
  {
    label: "Duration",
    icon: Clock,
    accentClass: "bg-warning/10 text-warning",
  },
  {
    label: "Dictation Speed",
    icon: Zap,
    accentClass: "bg-success/10 text-success",
  },
] as const;

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
  const [relationshipMemory, setRelationshipMemory] = useState<RelationshipMemory | null>(null);
  const [relationshipMemoryLoading, setRelationshipMemoryLoading] = useState(true);
  const [relationshipMemoryError, setRelationshipMemoryError] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const { dictationReady, meetingReady, loading: setupLoading } = useSetupStatus();

  const entitlement = deriveEntitlement(license);

  useEffect(() => {
    void validateLicense().then(setLicense).catch(() => {});
  }, []);

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
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await askMemory(buildThreadedMemoryQuery(query));
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
      setMemoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryLoading(false);
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
        title="Home"
        subtitle="Dictation, meetings, and follow-through in one place"
        actions={
          <Button onClick={() => requestMainView("dictation")}>
            <Mic className="mr-2 h-4 w-4" />
            Start Dictation
          </Button>
        }
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8">
          {/* Quick Stats */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {QUICK_STATS.map((stat) => {
              const Icon = stat.icon;
              const value =
                stat.label === "Projects"
                  ? String(projects.length)
                  : stat.label === "Meetings"
                    ? String(recordings.length)
                    : stat.label === "Duration"
                      ? `${Math.floor(totalDuration / 3600)}h ${Math.floor((totalDuration % 3600) / 60)}m`
                      : (
                          <AnimatedGradientText colorFrom="#34d399" colorTo="#10b981" className="text-2xl font-bold">
                            4x faster
                          </AnimatedGradientText>
                        );
              const supportingCopy = stat.label === "Dictation Speed" ? "than typing" : null;
              return (
                <Card
                  key={stat.label}
                  variant="interactive"
                  className="overflow-hidden border-border/80 bg-linear-to-br from-card via-card to-muted/30"
                >
                  <CardContent className="flex min-h-40 flex-col gap-6 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                        {stat.label}
                      </p>
                      <div className={cn("flex size-10 items-center justify-center rounded-2xl", stat.accentClass)}>
                        <Icon className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="mt-auto min-w-0">
                      <p className="text-3xl font-semibold tracking-tight text-card-foreground">{value}</p>
                      {supportingCopy && (
                        <p className="mt-1 text-sm text-muted-foreground">{supportingCopy}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Setup Status */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className={cn(
              "transition-colors hover-lift border-border/80 bg-card",
              dictationReady ? "shadow-[0_0_0_1px_hsl(var(--success)/0.12)]" : "shadow-[0_0_0_1px_hsl(var(--warning)/0.16)]"
            )}>
              <CardContent className="flex min-h-32 flex-col gap-4 p-5 sm:flex-row sm:items-center">
                <div className={cn(
                  "flex size-12 shrink-0 items-center justify-center rounded-2xl",
                  dictationReady ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                )}>
                  {setupLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : dictationReady ? <CheckCircle2 className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium text-card-foreground">Dictation</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {setupLoading ? "Checking…" : dictationReady ? "Ready to go" : "Needs setup"}
                  </p>
                </div>
                {!setupLoading && !dictationReady && (
                  <Button size="sm" variant="outline" onClick={() => requestOnboarding("dictation")}>
                    Fix
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card className={cn(
              "transition-colors hover-lift border-border/80 bg-card",
              meetingReady ? "shadow-[0_0_0_1px_hsl(var(--success)/0.12)]" : "shadow-[0_0_0_1px_hsl(var(--warning)/0.16)]"
            )}>
              <CardContent className="flex min-h-32 flex-col gap-4 p-5 sm:flex-row sm:items-center">
                <div className={cn(
                  "flex size-12 shrink-0 items-center justify-center rounded-2xl",
                  meetingReady ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                )}>
                  {setupLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : meetingReady ? <CheckCircle2 className="h-5 w-5" /> : <FileAudio className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-base font-medium text-card-foreground">Meetings</p>
                    {meetingReady && <Badge variant="success" size="sm">Ready</Badge>}
                    {!setupLoading && !meetingReady && <Badge variant="warning" size="sm">Setup needed</Badge>}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {setupLoading ? "Checking…" : meetingReady ? "Ready to go" : "Needs setup"}
                  </p>
                </div>
                {!setupLoading && !meetingReady && (
                  <Button size="sm" variant="outline" onClick={() => requestOnboarding("meetings")}>
                    Fix
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Daily Cockpit */}
          <Card variant="default" className="hover-lift border-border/80">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Daily Cockpit
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
                <div className="flex min-w-0 flex-col gap-4">
                  <div>
                    <p className="text-xl font-semibold tracking-tight text-card-foreground">{setupHeadline}</p>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                      Open dictation, meetings, or setup from one place.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => requestMainView("dictation")}>
                      <Mic className="mr-2 h-4 w-4" />
                      Open dictation
                    </Button>
                    <Button variant="outline" onClick={() => requestMainView("recordings")}>
                      <FileAudio className="mr-2 h-4 w-4" />
                      Open meetings
                    </Button>
                    <Button variant="outline" onClick={() => requestMainView("setup")}>
                      <Rocket className="mr-2 h-4 w-4" />
                      Open setup
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/25 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Typical workflow
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
                    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                      <p className="text-sm font-medium">1. Capture</p>
                      <p className="mt-1 text-xs text-muted-foreground">Dictate anywhere or run a meeting with notes live.</p>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                      <p className="text-sm font-medium">2. Review</p>
                      <p className="mt-1 text-xs text-muted-foreground">Use summaries, action items, memory, and edits to confirm the result.</p>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                      <p className="text-sm font-medium">3. Share</p>
                      <p className="mt-1 text-xs text-muted-foreground">Copy the follow-up, task list, or next agenda before context fades.</p>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          {/* Second Brain - Memory */}
          <Card className={cn(!entitlement.proEnabled && "opacity-60", "border-primary/20 hover-lift")}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                    <Brain className="h-4 w-4 text-primary" />
                  </div>
                  Second Brain
                  <TierBadge required="pro" unlocked={entitlement.proEnabled} />
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
                  disabled={!entitlement.proEnabled}
                />
                <Button
                  aria-label="Send"
                  onClick={() => void runMemoryQuery()}
                  disabled={!entitlement.proEnabled || memoryLoading || !memoryQuery.trim()}
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
                        message.role === "user" ? "bg-primary/10 ml-8" : "bg-muted/30 mr-8"
                      )}
                    >
                      <p className="text-sm">{message.content}</p>
                      {message.citations && message.citations.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {message.citations.map((citation, idx) => (
                            <div key={idx} className="text-xs text-muted-foreground border-l-2 border-primary/30 pl-2">
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
              <CardTitle className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <Users className="h-4 w-4 text-primary" />
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
                            disabled={!entitlement.proEnabled || memoryLoading}
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
                            disabled={!entitlement.proEnabled || memoryLoading}
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
              <CardTitle className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                  <Search className="h-4 w-4 text-blue-500" />
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
                <div className="space-y-2 rounded-lg border-l-2 border-l-blue-500/40 bg-muted/20 p-4 text-sm">
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
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/50 mb-3">
                    <FileAudio className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="font-medium">No meetings yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">Start recording to see them here.</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {recentRecordings.map((recording) => (
                    <div
                      key={recording.id}
                      className="group flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/50 cursor-pointer"
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
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="projects" className="space-y-4">
              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/50 mb-3">
                    <Folder className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="font-medium">No projects yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">Create your first project to organize meetings.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {projects.map((project) => (
                    <Card key={project.id} className="group cursor-pointer transition-colors hover:border-primary/30">
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10">
                            <Folder className="h-3.5 w-3.5 text-blue-500" />
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
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/50 mb-3">
                    <Clock className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="font-medium">No timeline yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">Sessions will appear here as they are captured.</p>
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
