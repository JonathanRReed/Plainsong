import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Download,
  Trash2,
  HardDrive,
  Check,
  AlertCircle,
  Cpu
} from "lucide-react";

interface DownloadedModel {
  name: string;
  provider: string;
  path: string;
  sizeBytes: number;
  downloadedAt: string;
}

interface ModelDownloaderProps {
  className?: string;
}

const WHISPER_MODELS = [
  { name: "tiny", sizeMb: 75, description: "Fastest, lowest accuracy", englishOnly: false },
  { name: "tiny.en", sizeMb: 75, description: "Fastest, English only", englishOnly: true },
  { name: "base", sizeMb: 142, description: "Good balance for multilingual", englishOnly: false },
  { name: "base.en", sizeMb: 142, description: "Good balance, English only", englishOnly: true },
  { name: "small", sizeMb: 466, description: "Better accuracy", englishOnly: false },
  { name: "small.en", sizeMb: 466, description: "Better accuracy, English only", englishOnly: true },
  { name: "medium", sizeMb: 1500, description: "High accuracy", englishOnly: false },
  { name: "medium.en", sizeMb: 1500, description: "High accuracy, English only", englishOnly: true },
  { name: "large-v3", sizeMb: 2900, description: "Best accuracy, multilingual", englishOnly: false },
];

export function ModelDownloader({ className }: ModelDownloaderProps) {
  const [downloadedModels, setDownloadedModels] = useState<DownloadedModel[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [availableSpace, setAvailableSpace] = useState<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadDownloadedModels();
    loadAvailableSpace();
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const loadDownloadedModels = async () => {
    try {
      const models = await invoke<DownloadedModel[]>("list_downloaded_models");
      setDownloadedModels(models);
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
    }
  };

  const loadAvailableSpace = async () => {
    try {
      const space = await invoke<number>("get_available_space");
      setAvailableSpace(space);
    } catch (error) {
      console.error("Failed to load available space:", error);
    }
  };

  const handleDownload = async (modelName: string) => {
    setDownloadingModel(modelName);
    setDownloadProgress(0);
    
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    try {
      // Simulate progress updates (in production, use event listeners)
      intervalRef.current = setInterval(() => {
        setDownloadProgress(prev => {
          if (prev >= 95) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            return prev;
          }
          return prev + Math.random() * 10;
        });
      }, 500);

      await invoke("download_whisper_model", { modelName });
      
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setDownloadProgress(100);
      
      // Refresh list
      await loadDownloadedModels();
      await loadAvailableSpace();
    } catch (error) {
      console.error("Failed to download model:", error);
    } finally {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setTimeout(() => {
        setDownloadingModel(null);
        setDownloadProgress(0);
      }, 1000);
    }
  };

  const handleDelete = async (path: string) => {
    if (!confirm("Are you sure you want to delete this model?")) return;
    
    try {
      await invoke("delete_model", { path });
      await loadDownloadedModels();
      await loadAvailableSpace();
    } catch (error) {
      console.error("Failed to delete model:", error);
    }
  };

  const isModelDownloaded = (modelName: string) => {
    const fileName = `ggml-${modelName}.bin`;
    return downloadedModels.some(m => m.path.includes(fileName));
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const totalDownloadedSize = downloadedModels.reduce((acc, m) => acc + m.sizeBytes, 0);

  return (
    <div className={cn("space-y-6", className)}>
      {/* Storage Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Models Downloaded</span>
              <span className="font-medium">{downloadedModels.length} models</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Size</span>
              <span className="font-medium">{formatBytes(totalDownloadedSize)}</span>
            </div>
            {availableSpace && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Available Space</span>
                <span className="font-medium">{formatBytes(availableSpace)}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Downloaded Models */}
      {downloadedModels.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Downloaded Models</CardTitle>
            <CardDescription>
              Manage your downloaded ASR models
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[200px]">
              <div className="space-y-2">
                {downloadedModels.map((model) => (
                  <div
                    key={model.path}
                    className="flex items-center justify-between p-3 border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded bg-green-100 dark:bg-green-900 flex items-center justify-center">
                        <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{model.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(model.sizeBytes)}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => handleDelete(model.path)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Available Models */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Cpu className="h-5 w-5" />
            Available Models
          </CardTitle>
          <CardDescription>
            Download Whisper models for local transcription
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <div className="space-y-3">
              {WHISPER_MODELS.map((model) => {
                const isDownloaded = isModelDownloaded(model.name);
                const isDownloading = downloadingModel === model.name;
                
                return (
                  <div
                    key={model.name}
                    className={cn(
                      "flex items-center justify-between p-4 border rounded-lg",
                      isDownloaded && "bg-muted/50 border-green-200 dark:border-green-800"
                    )}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Whisper {model.name}</span>
                        {model.englishOnly && (
                          <Badge variant="secondary" className="text-xs">EN</Badge>
                        )}
                        {isDownloaded && (
                          <Badge variant="default" className="bg-green-600 text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Ready
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {model.description}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {model.sizeMb} MB
                      </p>
                    </div>
                    
                    {isDownloading ? (
                      <div className="w-32 space-y-1">
                        <Progress value={downloadProgress} className="h-2" />
                        <p className="text-xs text-center text-muted-foreground">
                          {downloadProgress.toFixed(0)}%
                        </p>
                      </div>
                    ) : isDownloaded ? (
                      <Button variant="ghost" size="sm" disabled>
                        <Check className="h-4 w-4 mr-2" />
                        Downloaded
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleDownload(model.name)}
                        disabled={downloadingModel !== null}
                      >
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Info */}
      <div className="p-4 bg-muted/50 rounded-lg flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
        <div className="text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-1">About Model Sizes</p>
          <p>
            Larger models provide better accuracy but require more memory and processing time. 
            For most use cases, <strong>base.en</strong> (142 MB) provides a good balance of speed and accuracy.
            The <strong>large-v3</strong> model (2.9 GB) provides the best quality but requires significant resources.
          </p>
        </div>
      </div>
    </div>
  );
}
