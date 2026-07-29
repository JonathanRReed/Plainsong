import { useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import { requestMainView } from "@/lib/navigation";
import { ChevronRight, Folder, Plus } from "lucide-react";

export function ProjectsView() {
  const { projects, isLoading, error, createProject } = useProjects();
  const { recordings } = useRecordings();
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");

  const recordingCountByProject = recordings.reduce<Record<string, number>>(
    (acc, recording) => {
      acc[recording.projectId] = (acc[recording.projectId] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      return;
    }

    await createProject({
      name: newProjectName.trim(),
      description: newProjectDescription.trim() || undefined,
    });

    setNewProjectName("");
    setNewProjectDescription("");
    setShowNewProject(false);
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        eyebrow="LIBRARY"
        title="Projects"
        subtitle="Groups for your recordings"
        actions={
          <Button onClick={() => setShowNewProject(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        }
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-6 py-6 lg:px-8">
          {error ? (
            <div className="rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust">
              {error}
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <span className="neume" />
              <p className="font-serif text-sm text-muted-foreground">Loading projects…</p>
            </div>
          ) : null}

          {!isLoading && !error && projects.length === 0 ? (
            <EmptyState
              icon={<Folder className="h-8 w-8 text-muted-foreground" />}
              title="No projects yet"
              description="Create a project, then pick it as the destination for dictation. Meeting recordings stay in the default project."
              action={{
                label: "Create project",
                onClick: () => setShowNewProject(true),
              }}
            />
          ) : null}

          {!isLoading && !error && projects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <Card key={project.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <Folder className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <CardTitle className="text-lg">{project.name}</CardTitle>
                          <p className="text-sm text-muted-foreground">
                            {recordingCountByProject[project.id] ?? 0} recordings
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => requestMainView("recordings")}
                      >
                        Open meetings
                        <ChevronRight data-icon="inline-end" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {project.description?.trim() || "No description"}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Once it exists you can send dictation to it from the dictation screen. Meeting
              recordings stay in the default project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                placeholder="Weekly team sync"
                value={newProjectName}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setNewProjectName(event.target.value)
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-description">Description (optional)</Label>
              <Input
                id="project-description"
                placeholder="Standing Monday call with the team"
                value={newProjectDescription}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setNewProjectDescription(event.target.value)
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewProject(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateProject} disabled={!newProjectName.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
