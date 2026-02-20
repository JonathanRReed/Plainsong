import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import { analyzeRecordings, askMemory, searchTranscripts, validateLicense } from "@/lib/tauri";
import type { LicenseInfo } from "@/lib/tauri";
import { deriveEntitlement } from "@/hooks/use-license-features";
import { Folder, FileAudio, Clock, Activity, Brain, Loader2 } from "lucide-react";
import { TierBadge } from "@/components/tier-badge";

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
  const [memoryAnswer, setMemoryAnswer] = useState<string | null>(null);
  const [memoryCitations, setMemoryCitations] = useState<Array<{
    text: string;
    startTime?: number;
    endTime?: number;
    recordingId?: string;
  }>>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);

  const entitlement = deriveEntitlement(license);

  useEffect(() => {
    void validateLicense().then(setLicense).catch(() => {});
  }, []);

  const recentRecordings = useMemo(() => recordings.slice(0, 10), [recordings]);
  const totalDuration = useMemo(() => recordings.reduce((acc, r) => acc + r.duration, 0), [recordings]);
  const timelineGroups = useMemo(() => recordings.reduce<Record<string, typeof recordings>>((acc, recording) => {
    const key = new Date(recording.createdAt).toLocaleDateString();
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(recording);
    return acc;
  }, {}), [recordings]);

  const runMemoryQuery = async () => {
    if (!memoryQuery.trim()) return;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await askMemory(memoryQuery.trim());
      setMemoryAnswer(result.response);
      setMemoryCitations(result.citations);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryLoading(false);
    }
  };

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
      <div className="p-6 border-b">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground">Cold Storage Overview</p>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Projects</CardTitle>
                <Folder className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{projects.length}</div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Recordings</CardTitle>
                <FileAudio className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{recordings.length}</div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {Math.floor(totalDuration / 3600)}h {Math.floor((totalDuration % 3600) / 60)}m
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Storage Status</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">Local</div>
              </CardContent>
            </Card>
          </div>
          
          <Card className={!entitlement.proEnabled ? "opacity-75" : ""}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-violet-500" />
                Memory
                <TierBadge required="pro" unlocked={entitlement.proEnabled} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Ask anything about your meetings. Nautilus searches all transcripts and answers with citations.
              </p>
              <div className="flex gap-2">
                <Input
                  value={memoryQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setMemoryQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runMemoryQuery(); }}
                  placeholder={entitlement.proEnabled ? "What did we decide about the Q3 budget?" : "Requires Pro license or trial"}
                  disabled={!entitlement.proEnabled || memoryLoading}
                />
                <Button
                  onClick={() => void runMemoryQuery()}
                  disabled={!entitlement.proEnabled || memoryLoading || !memoryQuery.trim()}
                >
                  {memoryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ask"}
                </Button>
              </div>
              {memoryError && <p className="text-sm text-destructive">{memoryError}</p>}
              {memoryAnswer && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <p className="whitespace-pre-wrap">{memoryAnswer}</p>
                  {memoryCitations.length > 0 && (
                    <div className="space-y-1 border-t pt-2">
                      {memoryCitations.map((c, i) => (
                        <p key={i} className="text-xs text-muted-foreground">
                          [{c.recordingId ?? "recording"}] {c.startTime?.toFixed(1)}s–{c.endTime?.toFixed(1)}s: {c.text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cross-Recording Search</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={globalQuery}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setGlobalQuery(event.target.value)}
                  placeholder="Search across all transcripts..."
                />
                <Button onClick={runGlobalSearch} disabled={isSearching || !globalQuery.trim()}>
                  {isSearching ? "Searching..." : "Search"}
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto rounded-md border p-2">
                  {searchResults.map((hit) => {
                    const isSelected = selectedRecordingIds.includes(hit.recordingId);
                    return (
                      <label key={`${hit.recordingId}-${hit.segmentId}`} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => {
                            setSelectedRecordingIds((prev) => {
                              if (event.target.checked) {
                                return [...new Set([...prev, hit.recordingId])];
                              }
                              return prev.filter((id) => id !== hit.recordingId);
                            });
                          }}
                        />
                        <div>
                          <p className="font-medium">{hit.recordingTitle}</p>
                          <p className="text-xs text-muted-foreground">
                            {hit.startTime.toFixed(1)}s - {hit.endTime.toFixed(1)}s · {hit.text}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  value={analysisQuery}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setAnalysisQuery(event.target.value)}
                  placeholder="Ask across selected recordings..."
                />
                <Button
                  onClick={runMultiRecordingAnalysis}
                  disabled={isAnalyzing || !analysisQuery.trim() || selectedRecordingIds.length === 0}
                >
                  {isAnalyzing ? "Analyzing..." : "Analyze"}
                </Button>
              </div>

              {analysisError && (
                <p className="text-sm text-destructive">{analysisError}</p>
              )}

              {multiAnalysisResult && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <p className="whitespace-pre-wrap">{multiAnalysisResult}</p>
                  {multiAnalysisCitations.length > 0 && (
                    <div className="space-y-1 border-t pt-2">
                      {multiAnalysisCitations.map((citation, index) => (
                        <p key={index} className="text-xs text-muted-foreground">
                          [{citation.recordingId ?? "recording"}] {citation.startTime?.toFixed(1)}s-{citation.endTime?.toFixed(1)}s: {citation.text}
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
              <TabsTrigger value="recent">Recent Recordings</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>
            
            <TabsContent value="recent" className="space-y-4">
              {recentRecordings.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  No recordings yet. Start capturing to see them here.
                </div>
              ) : (
                <div className="space-y-2">
                  {recentRecordings.map((recording) => (
                    <div
                      key={recording.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 cursor-pointer"
                    >
                      <div>
                        <p className="font-medium">{recording.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {Math.floor(recording.duration / 60)}:{(recording.duration % 60).toString().padStart(2, '0')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            
            <TabsContent value="projects" className="space-y-4">
              {projects.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  No projects yet. Create your first project to organize recordings.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {projects.map((project) => (
                    <Card key={project.id} className="cursor-pointer hover:bg-accent/50">
                      <CardHeader>
                        <CardTitle className="text-lg">{project.name}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground">
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
                <div className="text-center py-12 text-muted-foreground">
                  No recordings yet. Timeline will populate as recordings are created.
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(timelineGroups).map(([date, items]) => (
                    <Card key={date}>
                      <CardHeader>
                        <CardTitle className="text-base">{date}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {items.map((recording) => (
                          <div key={recording.id} className="flex items-center justify-between text-sm">
                            <span>{recording.title}</span>
                            <span className="text-muted-foreground">
                              {new Date(recording.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
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
