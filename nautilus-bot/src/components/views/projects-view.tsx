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
import { ChevronRight, Folder, MoreHorizontal, Plus } from "lucide-react";

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
        subtitle="Organize recordings and personal libraries"
        actions={
          <Button onClick={() => setShowNewProject(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </Button>
        }
      />

      <ScrollArea className="flex-1">
        <div className="p-6">
          {error ? (
            <Card variant="default">
              <CardContent className="py-6 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          ) : null}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <span className="neume" />
              <p className="font-serif text-sm text-muted-foreground">Loading projects...</p>
            </div>
          ) : null}

          {!isLoading && !error && projects.length === 0 ? (
            <EmptyState
              icon={<Folder className="h-8 w-8 text-muted-foreground" />}
              title="No projects yet"
              description="Create your first project to organize recordings and keep work separated."
              action={{
                label: "Create Project",
                onClick: () => setShowNewProject(true),
              }}
            />
          ) : null}

          {!isLoading && !error && projects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <Card
                  key={project.id}
                  variant="interactive"
                  className="group"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-muted/20 flex items-center justify-center">
                          <Folder className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div>
                          <CardTitle className="text-lg">{project.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {recordingCountByProject[project.id] ?? 0} recordings
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={`Options for ${project.name}`} className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {project.description?.trim() || "No description"}
                    </p>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span className="font-mono uppercase tracking-widest text-[10px]">
                        {project.encrypted ? "Encrypted" : "Standard"}
                      </span>
                      <span className="transition-smooth flex items-center gap-2 text-muted-foreground group-hover:text-gold-text">
                        View recordings
                        <ChevronRight className="transition-smooth h-3 w-3 group-hover:translate-x-0.5" />
                      </span>
                    </div>
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
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>
              Create a new project to organize your recordings.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project Name</Label>
              <Input
                id="project-name"
                placeholder="Enter project name"
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
                placeholder="Enter project description"
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
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
