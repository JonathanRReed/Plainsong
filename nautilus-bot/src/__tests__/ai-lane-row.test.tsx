import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiLaneRow } from "@/components/models/ai-lane-row";

function renderRow(
  modelId: string | null,
  onModelChange = vi.fn(),
  remoteProcessingEnabled = false,
) {
  render(
    <AiLaneRow
      lane="dictationAi"
      label="Dictation writing"
      help="Choose the model used to rewrite dictation."
      value={{ provider: "ollama", modelId }}
      remoteProcessingEnabled={remoteProcessingEnabled}
      models={["hf.co/example/paraphraser", "gemma4:e4b"]}
      modelsLoading={false}
      onProviderChange={vi.fn()}
      onRefreshModels={vi.fn()}
      onModelChange={onModelChange}
    />,
  );
  return {
    select: screen.getByLabelText("Model") as HTMLSelectElement,
    onModelChange,
  };
}

describe("AiLaneRow model selection", () => {
  it("shows a null model as the provider default", () => {
    const { select } = renderRow(null);

    expect(select).toHaveValue("");
    expect(select.selectedOptions[0]?.textContent).toBe("The service's default");
  });

  it("shows an explicit installed model and persists exact changes", () => {
    const onModelChange = vi.fn();
    const { select } = renderRow("gemma4:e4b", onModelChange);

    expect(select).toHaveValue("gemma4:e4b");
    fireEvent.change(select, { target: { value: "hf.co/example/paraphraser" } });
    expect(onModelChange).toHaveBeenCalledWith(
      "dictationAi",
      "hf.co/example/paraphraser",
    );

    fireEvent.change(select, { target: { value: "" } });
    expect(onModelChange).toHaveBeenLastCalledWith("dictationAi", null);
  });

  it("keeps an unknown stored model visible", () => {
    const { select } = renderRow("custom-model:latest");

    expect(select).toHaveValue("custom-model:latest");
    expect(select.selectedOptions[0]?.textContent).toBe("custom-model:latest");
  });

  it("discloses cloud aliases without promising an unknown Ollama model stays local", () => {
    renderRow("custom-cloud-alias:latest", vi.fn(), true);

    expect(
      screen.getByText(/Ollama cloud models send text off this Mac, so they need cloud AI turned on/),
    ).toBeInTheDocument();
    expect(screen.getByText(/and so do models Plainsong hasn't checked/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing leaves the machine/i)).not.toBeInTheDocument();
  });
});
