import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import { Folder, FileAudio, Clock, Activity } from "lucide-react";

export function DashboardView() {
  const { projects } = useProjects();
  const { recordings } = useRecordings();

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
