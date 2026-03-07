import { useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <div className="p-6 border-b flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-muted-foreground">Organize recordings and workspaces</p>
        </div>
        <Button onClick={() => setShowNewProject(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Project
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {error ? (
            <Card>
              <CardContent className="py-6 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          ) : null}

          {isLoading ? (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                Loading projects...
              </CardContent>
            </Card>
          ) : null}

          {!isLoading && !error && projects.length === 0 ? (
            <div className="text-center py-12">
              <Folder className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No projects yet</h3>
              <p className="text-muted-foreground mt-1">
                Create your first project to organize recordings.
              </p>
              <Button className="mt-4" onClick={() => setShowNewProject(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Project
              </Button>
            </div>
          ) : null}

          {!isLoading && !error && projects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <Card
                  key={project.id}
                  className="cursor-pointer hover:border-trusted transition-colors"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-trusted/10 flex items-center justify-center">
                          <Folder className="h-5 w-5 text-trusted" />
                        </div>
                        <div>
                          <CardTitle className="text-lg">{project.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {recordingCountByProject[project.id] ?? 0} recordings
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {project.description?.trim() || "No description"}
                    </p>
                    <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
                      <span>{project.encrypted ? "Encrypted" : "Standard"}</span>
                      <span className="flex items-center gap-2">
                        View recordings
                        <ChevronRight className="h-3 w-3" />
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
