import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AsrProviderInfo, AsrProviderType, BenchmarkResult } from "@/types";
import { 
  Download, 
  Check, 
  AlertCircle, 
  Cpu, 
  Globe, 
  Clock,
  BarChart3,
  FileAudio
} from "lucide-react";

interface AsrProviderManagerProps {
  className?: string;
}

export function AsrProviderManager({ className }: AsrProviderManagerProps) {
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<AsrProviderType>("whisper");
  const [isLoading, setIsLoading] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);

  useEffect(() => {
    loadProviders();
    loadDefaultProvider();
  }, []);

  const loadProviders = async () => {
    try {
      const data = await invoke<AsrProviderInfo[]>("get_asr_providers");
      setProviders(data);
    } catch (error) {
      console.error("Failed to load ASR providers:", error);
    }
  };

  const loadDefaultProvider = async () => {
    try {
      const provider = await invoke<AsrProviderType>("get_default_asr_provider");
      setDefaultProvider(provider);
    } catch (error) {
      console.error("Failed to load default provider:", error);
    }
  };

  const handleSetDefault = async (providerType: AsrProviderType) => {
    try {
      await invoke("set_default_asr_provider", { providerType });
      setDefaultProvider(providerType);
    } catch (error) {
      console.error("Failed to set default provider:", error);
    }
  };

  const handleDownload = async (providerType: AsrProviderType) => {
    setIsLoading(true);
    try {
      await invoke("download_asr_models", { providerType });
      await loadProviders();
    } catch (error) {
      console.error("Failed to download models:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const runBenchmark = async () => {
    const testPath = "/path/to/test/audio.wav";
    try {
      const results = await invoke<BenchmarkResult[]>("benchmark_asr_providers", {
        testAudioPath: testPath,
      });
      setBenchmarkResults(results);
    } catch (error) {
      console.error("Benchmark failed:", error);
    }
  };

  const getProviderIcon = (type: AsrProviderType) => {
    switch (type) {
      case "whisper":
        return <Globe className="h-5 w-5" />;
      default:
        return <Cpu className="h-5 w-5" />;
    }
  };

  const getDownloadStatusBadge = (status: AsrProviderInfo["downloadStatus"]) => {
    if (!status) return null;
    
    const statusObj = status as Record<string, unknown>;
    
    if ("Downloaded" in statusObj) {
      return (
        <Badge variant="default" className="bg-green-600">
          <Check className="h-3 w-3 mr-1" />
          Ready
        </Badge>
      );
    } else if ("NotDownloaded" in statusObj) {
      return (
        <Badge variant="secondary">
          <Download className="h-3 w-3 mr-1" />
          Download Required
        </Badge>
      );
    } else if ("Downloading" in statusObj) {
      const progress = (statusObj.Downloading as { progress: number })?.progress || 0;
      return (
        <div className="flex items-center gap-2">
          <Progress value={progress} className="w-20 h-2" />
          <span className="text-xs text-muted-foreground">{progress.toFixed(0)}%</span>
        </div>
      );
    } else if ("Error" in statusObj) {
      return (
        <Badge variant="destructive">
          <AlertCircle className="h-3 w-3 mr-1" />
          Error
        </Badge>
      );
    }
    return null;
  };

  const isDownloaded = (status: AsrProviderInfo["downloadStatus"]): boolean => {
    if (!status) return false;
    return typeof status === "object" && "Downloaded" in (status as Record<string, unknown>);
  };

  const isNotDownloaded = (status: AsrProviderInfo["downloadStatus"]): boolean => {
    if (!status) return false;
    return typeof status === "object" && "NotDownloaded" in (status as Record<string, unknown>);
  };

  return (
    <div className={cn("space-y-6", className)}>
      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          <div className="grid gap-4">
            {providers.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center">
                  <p className="text-muted-foreground">Loading providers...</p>
                </CardContent>
              </Card>
            ) : (
              providers.map((provider) => (
                <Card 
                  key={provider.providerType}
                  className={cn(
                    "transition-all",
                    defaultProvider === provider.providerType && "border-trusted ring-1 ring-trusted"
                  )}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-trusted/10 flex items-center justify-center text-trusted">
                          {getProviderIcon(provider.providerType)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-lg">{provider.name}</CardTitle>
                            {defaultProvider === provider.providerType && (
                              <Badge variant="outline" className="text-xs">
                                Default
                              </Badge>
                            )}
                          </div>
                          <CardDescription className="line-clamp-2 mt-1">
                            {provider.description}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {getDownloadStatusBadge(provider.downloadStatus)}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    {provider.modelInfo && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div className="p-2 bg-muted rounded-lg">
                          <div className="text-muted-foreground text-xs">Size</div>
                          <div className="font-medium">{provider.modelInfo.sizeMb} MB</div>
                        </div>
                        <div className="p-2 bg-muted rounded-lg">
                          <div className="text-muted-foreground text-xs">Parameters</div>
                          <div className="font-medium">{provider.modelInfo.parameters}</div>
                        </div>
                        <div className="p-2 bg-muted rounded-lg">
                          <div className="text-muted-foreground text-xs">WER</div>
                          <div className="font-medium">
                            {provider.modelInfo.wordErrorRate?.toFixed(2) || "N/A"}%
                          </div>
                        </div>
                        <div className="p-2 bg-muted rounded-lg">
                          <div className="text-muted-foreground text-xs">Speed</div>
                          <div className="font-medium">
                            {provider.modelInfo.realTimeFactor?.toFixed(0) || "N/A"}x RTF
                          </div>
                        </div>
                      </div>
                    )}

                    {provider.modelInfo?.languages && provider.modelInfo.languages.length > 0 && (
                      <div>
                        <div className="text-sm text-muted-foreground mb-2">
                          Supported Languages ({provider.modelInfo.languages.length})
                        </div>
                        <ScrollArea className="h-16">
                          <div className="flex flex-wrap gap-1">
                            {provider.modelInfo.languages.slice(0, 10).map((lang) => (
                              <Badge key={lang} variant="secondary" className="text-xs">
                                {lang.toUpperCase()}
                              </Badge>
                            ))}
                            {provider.modelInfo.languages.length > 10 && (
                              <Badge variant="secondary" className="text-xs">
                                +{provider.modelInfo.languages.length - 10} more
                              </Badge>
                            )}
                          </div>
                        </ScrollArea>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {provider.modelInfo?.license || "Unknown"}
                        </Badge>
                        {provider.modelInfo?.sourceUrl && (
                          <a
                            href={provider.modelInfo.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-trusted hover:underline"
                          >
                            Learn more
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isDownloaded(provider.downloadStatus) ? (
                          <Button
                            variant={defaultProvider === provider.providerType ? "default" : "outline"}
                            size="sm"
                            onClick={() => handleSetDefault(provider.providerType)}
                          >
                            {defaultProvider === provider.providerType ? "Default" : "Set Default"}
                          </Button>
                        ) : isNotDownloaded(provider.downloadStatus) ? (
                          <Button
                            size="sm"
                            onClick={() => handleDownload(provider.providerType)}
                            disabled={isLoading}
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="benchmark" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Performance Benchmark
              </CardTitle>
              <CardDescription>
                Compare transcription speed and accuracy across all available providers
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-center p-8 border-2 border-dashed rounded-lg">
                <div className="text-center">
                  <FileAudio className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4">
                    Upload a test audio file to benchmark all available providers
                  </p>
                  <Button onClick={runBenchmark} disabled={benchmarkResults.length > 0}>
                    <Clock className="h-4 w-4 mr-2" />
                    Run Benchmark
                  </Button>
                </div>
              </div>

              {benchmarkResults.length > 0 && (
                <div className="space-y-2">
                  {benchmarkResults.map((result) => (
                    <div
                      key={result.providerType}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{result.providerName}</p>
                        <p className="text-sm text-muted-foreground">
                          Confidence: {(result.confidence * 100).toFixed(1)}%
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-medium">
                          {(result.processingTimeMs / 1000).toFixed(2)}s
                        </p>
                        <p className="text-xs text-muted-foreground">Processing time</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Provider Status</CardTitle>
              <CardDescription>
                Production availability for ASR providers in this build
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-sm">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">🌍 Whisper (Enabled)</p>
                  <p className="text-muted-foreground">
                    Production transcription provider in this build. Supports model downloads and
                    end-to-end transcription.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">⚡ Parakeet (Not enabled)</p>
                  <p className="text-muted-foreground">
                    Model download path exists, but inference is not enabled in this production
                    build.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">🏆 Canary (Not enabled)</p>
                  <p className="text-muted-foreground">
                    Model download path exists, but inference is not enabled in this production
                    build.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
