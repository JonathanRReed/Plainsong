import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useRecordings } from "@/hooks/use-recordings";
import { useRecording } from "@/hooks/use-recording";
import { ConsentDialog } from "@/components/recording-overlay";
import { TranscriptViewer, TranscriptSearch } from "@/components/transcript-viewer";
import { WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  getRecordingWaveform,
  openRecordingAudio,
  getSpeakers,
  getTranscript,
  renameSpeaker,
  deleteRecording,
  renameRecording,
} from "@/lib/tauri";
import type { Recording, Transcript } from "@/types";
import {
  AlertCircle,
  BarChart3,
  Edit3,
  FileAudio,
  FileOutput,
  FileText,
  Loader2,
  Mic2,
  MoreHorizontal,
  Play,
  Square,
  Trash2,
} from "lucide-react";

export function RecordingsView() {
  const { recordings, refetch } = useRecordings();
  const { startMeeting, stopMeeting, isRecording } = useRecording();
  const [showConsent, setShowConsent] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [showRecordingDetail, setShowRecordingDetail] = useState(false);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Recording | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const lastRecordingState = useRef(false);

  useEffect(() => {
    if (lastRecordingState.current && !isRecording) {
      refetch();
    }
    lastRecordingState.current = isRecording;
  }, [isRecording, refetch]);

  const handleStartRecording = async (options: { mic: boolean; systemAudio: boolean }) => {
    await startMeeting({ ...options, projectId: "default" });
    setShowConsent(false);
  };

  const loadRecordingDetail = async (recording: Recording) => {
    setIsLoadingDetail(true);
    setDetailError(null);
    setSelectedTranscript(null);
    setSpeakerNames({});
    setWaveformData([]);
    setSearchQuery("");

    try {
      const [transcript, waveform, speakers] = await Promise.all([
        getTranscript(recording.id),
        getRecordingWaveform(recording.id, 500),
        getSpeakers(recording.id),
      ]);
      setSelectedTranscript(transcript);
      setWaveformData(waveform);
      setSpeakerNames(
        speakers.reduce<Record<string, string>>((acc, speaker) => {
          if (speaker.name) {
            acc[speaker.id] = speaker.name;
          }
          return acc;
        }, {})
      );
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Failed to load recording details");
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleRecordingClick = (recording: Recording) => {
    setSelectedRecording(recording);
    setShowRecordingDetail(true);
    void loadRecordingDetail(recording);
  };

  const handleRenameSpeaker = async (speakerId: string, newName: string) => {
    if (!selectedRecording) {
      return;
    }
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
    await renameSpeaker(selectedRecording.id, speakerId, newName);
  };

  const handlePlayAudio = async (recording: Recording) => {
    if (recording.audioPath) {
      try {
        await openRecordingAudio(recording.id);
      } catch (err) {
        console.error("Failed to open audio file:", err);
      }
    }
  };

  const handleDeleteRecording = async () => {
    if (!showDeleteConfirm) return;
    try {
      await deleteRecording(showDeleteConfirm.id);
      refetch();
    } catch (err) {
      console.error("Failed to delete recording:", err);
    } finally {
      setShowDeleteConfirm(null);
    }
  };

  const handleRenameRecording = async () => {
    if (!showRenameDialog || !renameValue.trim()) return;
    try {
      await renameRecording(showRenameDialog.id, renameValue.trim());
      refetch();
    } catch (err) {
      console.error("Failed to rename recording:", err);
    } finally {
      setShowRenameDialog(null);
      setRenameValue("");
    }
  };

  const filteredSegments = useMemo(() => {
    if (!selectedTranscript) {
      return [];
    }
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return selectedTranscript.segments;
    }
    return selectedTranscript.segments.filter((segment) => {
      const speaker = segment.speakerId?.toLowerCase() ?? "";
      return (
        segment.text.toLowerCase().includes(query) ||
        speaker.includes(query)
      );
    });
  }, [selectedTranscript, searchQuery]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Recordings</h1>
          <p className="text-muted-foreground">Manage your captured audio</p>
        </div>
        <div className="flex gap-2">
          {isRecording ? (
            <Button variant="destructive" onClick={stopMeeting}>
              <Square className="h-4 w-4 mr-2 fill-current" />
              Stop Recording
            </Button>
          ) : (
            <Button variant="active" onClick={() => setShowConsent(true)}>
              <Mic2 className="h-4 w-4 mr-2" />
              New Recording
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {recordings.length === 0 ? (
            <div className="text-center py-12">
              <FileAudio className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No recordings yet</h3>
              <p className="text-muted-foreground mt-1">
                Start recording to capture meetings and dictations
              </p>
              <Button className="mt-4" variant="active" onClick={() => setShowConsent(true)}>
                <Mic2 className="h-4 w-4 mr-2" />
                Start Recording
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {recordings.map((recording) => (
                <Card
                  key={recording.id}
                  className="hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => handleRecordingClick(recording)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-lg bg-trusted/10 flex items-center justify-center">
                          <FileAudio className="h-5 w-5 text-trusted" />
                        </div>
                        <div>
                          <h3 className="font-medium">{recording.title}</h3>
                          <p className="text-sm text-muted-foreground">
                            {new Date(recording.createdAt).toLocaleString()} · {recording.sourceType}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                          {Math.floor(recording.duration / 60)}:
                          {(recording.duration % 60).toString().padStart(2, "0")}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePlayAudio(recording);
                          }}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenameValue(recording.title);
                                setShowRenameDialog(recording);
                              }}
                            >
                              <Edit3 className="h-4 w-4 mr-2" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRecordingClick(recording);
                              }}
                            >
                              <FileOutput className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowDeleteConfirm(recording);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <ConsentDialog
        open={showConsent}
        onOpenChange={setShowConsent}
        onStart={handleStartRecording}
      />

      <Dialog
        open={showRecordingDetail}
        onOpenChange={(open) => {
          setShowRecordingDetail(open);
          if (!open) {
            setSelectedRecording(null);
            setSelectedTranscript(null);
            setSpeakerNames({});
            setWaveformData([]);
            setSearchQuery("");
            setDetailError(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{selectedRecording?.title ?? "Recording"}</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="transcript" className="flex-1 flex flex-col">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="transcript" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Transcript
              </TabsTrigger>
              <TabsTrigger value="audio" className="flex items-center gap-2">
                <FileAudio className="h-4 w-4" />
                Audio
              </TabsTrigger>
              <TabsTrigger value="analysis" className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Analysis
              </TabsTrigger>
            </TabsList>

            <TabsContent value="transcript" className="flex-1 flex flex-col">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading transcript...
                </div>
              ) : detailError ? (
                <div className="flex-1 flex items-center justify-center text-destructive">
                  <AlertCircle className="h-5 w-5 mr-2" />
                  {detailError}
                </div>
              ) : selectedTranscript ? (
                <>
                  <TranscriptSearch
                    onSearch={setSearchQuery}
                    className="mb-4"
                  />
                  <div className="flex-1 border rounded-lg overflow-hidden">
                    <TranscriptViewer
                      segments={filteredSegments}
                      speakerNames={speakerNames}
                      onRenameSpeaker={handleRenameSpeaker}
                    />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  Transcript is not available yet. It will appear after processing completes.
                </div>
              )}
            </TabsContent>

            <TabsContent value="audio" className="flex-1 flex flex-col">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading audio waveform...
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 border rounded-lg">
                    <h3 className="font-medium mb-2">Waveform</h3>
                    <WaveformVisualizer data={waveformData} height={100} />
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-3 bg-muted rounded-lg">
                      <span className="text-muted-foreground">Duration:</span>{" "}
                      <span className="font-medium">
                        {Math.floor((selectedRecording?.duration || 0) / 60)}:
                        {((selectedRecording?.duration || 0) % 60).toString().padStart(2, "0")}
                      </span>
                    </div>
                    <div className="p-3 bg-muted rounded-lg">
                      <span className="text-muted-foreground">Status:</span>{" "}
                      <span className="font-medium">{selectedRecording?.status ?? "unknown"}</span>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="analysis" className="flex-1 overflow-hidden">
              {selectedRecording ? (
                <ScrollArea className="h-full pr-2">
                  <AiAnalysisPanel recordingId={selectedRecording.id} />
                </ScrollArea>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Select a recording to analyze.
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={showDeleteConfirm !== null}
        onOpenChange={(open) => { if (!open) setShowDeleteConfirm(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Recording</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{showDeleteConfirm?.title}&rdquo;? This will
              permanently remove the recording, its transcript, and audio file.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteRecording}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={showRenameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setShowRenameDialog(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Recording</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRenameRecording()}
            placeholder="New recording title"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowRenameDialog(null); setRenameValue(""); }}>
              Cancel
            </Button>
            <Button onClick={handleRenameRecording} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
