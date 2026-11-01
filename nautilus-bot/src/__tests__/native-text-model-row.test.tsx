import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NativeTextModelProvider, NativeTextModelRow } from "@/components/models/native-text-model-row";
const api = vi.hoisted(() => ({ status: vi.fn(), download: vi.fn(), cancel: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/backend/ai", () => ({ getNativeTextModelStatus: api.status, downloadNativeTextModel: api.download, cancelNativeTextModelDownload: api.cancel, deleteNativeTextModel: api.remove }));
const base = { provider: "native_text", modelId: "qwen3-4b-instruct-2507-q4_k_m", displayName: "Qwen3 4B Instruct", downloadBytes: 2500000000, bytesOnDisk: 0, ready: false, missingFiles: ["weights"], runtimePresent: true, memoryAvailableBytes: 4000000000, memoryRequiredBytes: 15058959072, canLoadNow: false, qualified: false, contextTokens: 8192 };
beforeEach(() => { vi.resetAllMocks(); api.status.mockResolvedValue(base); api.cancel.mockResolvedValue(undefined); });
describe("managed native text model", () => {
  it("preselects the recommended tier, keeps an explicit choice, and downloads that tier", async () => {
    const sizes = [
      { ...base, modelId: "light", size: "light", label: "Light", description: "Reads meetings in smaller parts.", modelMemoryBytes: 2_000_000_000, recommended: true },
      { ...base, modelId: "balanced", size: "balanced", label: "Balanced", description: "Uses the larger model.", modelMemoryBytes: 3_500_000_000, recommended: false },
      { ...base, modelId: "best", size: "best", label: "Best", description: "Reads more at once.", modelMemoryBytes: 4_500_000_000, recommended: false },
    ];
    api.status.mockResolvedValue({ ...base, recommendedModelId: "light", sizes });
    const change = vi.fn();
    const view = render(<NativeTextModelRow onModelChange={change} />);
    const picker = await screen.findByRole("combobox", { name: "Notes model" });
    expect(picker).toHaveValue("light");
    expect(screen.getByRole("option", { name: "Light (recommended) · 2.0 GB memory" })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "best" } });
    expect(change).toHaveBeenCalledWith("best");
    view.rerender(<NativeTextModelRow modelId="best" onModelChange={change} />);
    expect(picker).toHaveValue("best");
    api.download.mockResolvedValue({ ...base, recommendedModelId: "light", sizes });
    fireEvent.click(screen.getByRole("button", { name: "Download text model" }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith("best"));
  });

  it("shares a pending deletion and removed files across both AI rows", async () => {
    const onChanged = vi.fn();
    let finish!: (value: typeof base) => void;
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000 });
    api.remove.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<NativeTextModelProvider onChanged={onChanged}><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    expect(await screen.findAllByText("Files verified.")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove model files" })[0]);
    expect(screen.getAllByRole("button", { name: "Removing…" })).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: "Verify model files" })) expect(button).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Verify model files" })[1]);
    expect(api.download).not.toHaveBeenCalled();
    await act(async () => { finish(base); });
    expect(screen.queryByText("Files verified.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove model files" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download text model" })).toHaveLength(2);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("shares a pending download and verified files across both AI rows", async () => {
    let finish!: (value: typeof base) => void;
    api.download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<NativeTextModelProvider><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    const downloads = await screen.findAllByRole("button", { name: "Download text model" });
    await waitFor(() => { for (const button of downloads) expect(button).toBeEnabled(); });
    fireEvent.click(downloads[0]);
    expect(screen.getAllByText("Downloading…")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Download text model" })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Check model and memory" })) expect(button).toBeDisabled();
    await act(async () => { finish({ ...base, ready: true, bytesOnDisk: 2500000000 }); });
    expect(screen.getAllByText("Files verified.")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove model files" })).toHaveLength(2);
    expect(api.download).toHaveBeenCalledTimes(1);
  });
  it("refreshes both rows after a failed download leaves resumable files", async () => {
    api.download.mockRejectedValueOnce(new Error("error sending request for url (https://huggingface.co/x/model.gguf)"));
    render(<NativeTextModelProvider><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    const download = (await screen.findAllByRole("button", { name: "Download text model" }))[0];
    await waitFor(() => expect(download).toBeEnabled());
    api.status.mockResolvedValue({ ...base, bytesOnDisk: 1000000 });
    fireEvent.click(download);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove model files" })).toHaveLength(2));
    for (const alert of screen.getAllByRole("alert")) expect(alert).toHaveTextContent("Plainsong couldn't reach the download server. Check your internet connection, then try again.");
    for (const button of screen.getAllByRole("button", { name: "Download text model" })) expect(button).toBeEnabled();
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("retains a refused deletion cause in both rows after refreshing shared files", async () => {
    const message = "An earlier Ollama request may still be running.";
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000 });
    api.remove.mockRejectedValueOnce(new Error(message));
    render(<NativeTextModelProvider><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    const remove = (await screen.findAllByRole("button", { name: "Remove model files" }))[0];
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000, runtimeHealth: { state: "completion_unknown", message } });
    fireEvent.click(remove);
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: "Remove model files" })) expect(button).toBeEnabled();
    });
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    for (const alert of screen.getAllByRole("alert")) expect(alert).toHaveTextContent(message);
    expect(screen.queryByText("Could not remove the model files. Try again.")).not.toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("does not restore either row from a status request that predates deletion", async () => {
    const verified = { ...base, ready: true, bytesOnDisk: 2500000000 };
    let finishOlder!: (value: typeof base) => void;
    api.status.mockResolvedValueOnce(verified);
    api.remove.mockResolvedValueOnce(base);
    render(<NativeTextModelProvider><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    expect(await screen.findAllByText("Files verified.")).toHaveLength(2);
    api.status.mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }));
    fireEvent.click(screen.getAllByRole("button", { name: "Check model and memory" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove model files" })[0]);
    await waitFor(() => expect(screen.queryByText("Files verified.")).not.toBeInTheDocument());
    await act(async () => { finishOlder(verified); });
    expect(screen.queryByText("Files verified.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove model files" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download text model" })).toHaveLength(2);
  });
  it("clears verified files in both rows when a failed mutation cannot refresh status", async () => {
    const message = "An earlier Ollama request may still be running.";
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000 });
    api.remove.mockRejectedValueOnce(new Error(message));
    render(<NativeTextModelProvider><NativeTextModelRow /><NativeTextModelRow /></NativeTextModelProvider>);
    const remove = (await screen.findAllByRole("button", { name: "Remove model files" }))[0];
    api.status.mockRejectedValueOnce(new Error("Unavailable"));
    fireEvent.click(remove);
    expect(await screen.findAllByText("Model status unavailable.")).toHaveLength(2);
    expect(screen.queryByText("Files verified.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove model files" })).not.toBeInTheDocument();
    for (const alert of screen.getAllByRole("alert")) expect(alert).toHaveTextContent(message);
  });
  it.each(["completion_unknown", "storage_error"] as const)("shows the %s cause separately from files and memory", async (state) => {
    const message = "Local processing is paused for the controlled test.";
    api.status.mockResolvedValue({ ...base, ready: true, canLoadNow: true, memoryAvailableBytes: 20000000000, runtimeHealth: { state, message } });
    render(<NativeTextModelRow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("Files verified.")).toBeVisible();
  });
  it("retains the pause cause after a refused delete refresh", async () => {
    const message = "An earlier Ollama request may still be running.";
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 1, runtimeHealth: { state: "completion_unknown", message } });
    api.remove.mockRejectedValue(new Error(message));
    render(<NativeTextModelRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove model files" }));
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("Could not remove the model files. Try again.")).not.toBeInTheDocument();
  });
  it("discloses the download and experimental qualification", async () => {
    render(<NativeTextModelRow />);
    expect(await screen.findByText("Qwen3 4B Instruct")).toBeVisible();
    expect(screen.getByText(/Experimental/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Download text model" })).toBeEnabled();
    expect(api.download).not.toHaveBeenCalled();
  });
  it("shows the memory requirement before downloading", async () => {
    render(<NativeTextModelRow />);
    expect(await screen.findByText("4.0 GB free now · 15.1 GB needed")).toBeVisible();
    expect(screen.getByText(/Not enough free memory right now/)).toBeVisible();
    expect(screen.getByText(/leaves room for other apps/)).toBeVisible();
    expect(screen.getByText("You can download the files now and use the model when enough memory is available.")).toBeVisible();
    expect(screen.queryByText("Files verified.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download text model" })).toBeEnabled();
  });
  it("separates verified files from blocked memory admission", async () => {
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000 });
    render(<NativeTextModelRow />);
    expect(await screen.findByText("Files verified.")).toBeVisible();
    expect(screen.getByText("4.0 GB free now · 15.1 GB needed")).toBeVisible();
    expect(screen.getByText(/Not enough free memory right now/)).toBeVisible();
    expect(screen.queryByText("There's enough free memory to load it.")).not.toBeInTheDocument();
    expect(screen.queryByText("You can download the files now and use the model when enough memory is available.")).not.toBeInTheDocument();
  });
  it("clears stale loading permission when a refresh fails", async () => {
    api.status.mockResolvedValueOnce({ ...base, ready: true, canLoadNow: true, memoryAvailableBytes: 20000000000 });
    render(<NativeTextModelRow />);
    expect(await screen.findByText("There's enough free memory to load it.")).toBeVisible();
    api.status.mockRejectedValueOnce(new Error("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Check model and memory" }));
    expect(await screen.findByText("Model status unavailable.")).toBeVisible();
    expect(screen.queryByText("There's enough free memory to load it.")).not.toBeInTheDocument();
    expect(screen.queryByText("Files verified.")).not.toBeInTheDocument();
    expect(screen.queryByText(/GB free now/)).not.toBeInTheDocument();
  });
  it("does not restore stale permission from an older overlapping refresh", async () => {
    const permitted = { ...base, ready: true, canLoadNow: true, memoryAvailableBytes: 20000000000 };
    let finishOlder!: (value: typeof base) => void;
    api.status.mockResolvedValueOnce(permitted);
    render(<NativeTextModelRow />);
    expect(await screen.findByText("There's enough free memory to load it.")).toBeVisible();
    api.status.mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }));
    api.status.mockRejectedValueOnce(new Error("Unavailable"));
    const check = screen.getByRole("button", { name: "Check model and memory" });
    fireEvent.click(check);
    fireEvent.click(check);
    expect(await screen.findByText("Model status unavailable.")).toBeVisible();
    await act(async () => { finishOlder(permitted); });
    expect(screen.getByText("Model status unavailable.")).toBeVisible();
    expect(screen.queryByText("There's enough free memory to load it.")).not.toBeInTheDocument();
  });
  it("offers cancellation while a download is pending", async () => {
    let finish!: (value: typeof base) => void;
    api.download.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<NativeTextModelRow />);
    const download = await screen.findByRole("button", { name: "Download text model" });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(api.cancel).toHaveBeenCalledTimes(1);
    finish({ ...base, ready: true, bytesOnDisk: 2500000000 });
    await screen.findByText(/Files verified/);
    expect(screen.getByText(/Not enough free memory/)).toBeVisible();
  });
  it("keeps a failed download retryable", async () => {
    api.download.mockRejectedValueOnce(new Error("error sending request for url (https://huggingface.co/x/model.gguf)"));
    render(<NativeTextModelRow />);
    const download = await screen.findByRole("button", { name: "Download text model" });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    expect(await screen.findByRole("alert")).toHaveTextContent("Plainsong couldn't reach the download server. Check your internet connection, then try again.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Download text model" })).toBeEnabled());
  });
  it("treats cancellation as a resumable status without exposing Electron errors", async () => {
    api.download.mockRejectedValueOnce(new Error("Error invoking remote method 'sidecar:invoke': Error: Native model download cancelled"));
    render(<NativeTextModelRow />);
    const download = await screen.findByRole("button", { name: "Download text model" });
    await waitFor(() => expect(download).toBeEnabled());
    api.status.mockResolvedValue({ ...base, bytesOnDisk: 1000000 });
    fireEvent.click(download);
    expect(await screen.findByText("Download cancelled. You can resume it later.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove model files" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Download text model" })).toBeEnabled();
  });
  it("does not claim low RAM when memory information is unavailable", async () => {
    api.status.mockResolvedValue({ ...base, ready: true, bytesOnDisk: 2500000000, memoryAvailableBytes: null });
    render(<NativeTextModelRow />);
    expect(await screen.findByText(/Plainsong couldn't check free memory/)).toBeVisible();
  });
});
