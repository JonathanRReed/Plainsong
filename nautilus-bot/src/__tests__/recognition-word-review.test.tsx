import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecognitionWordReview, recognitionWordsToReview } from "@/components/views/dictation/recognition-word-review";

const word = { word: "tailie", score: 0.533, startTime: 0.4, endTime: 0.8 };

describe("RecognitionWordReview", () => {
  it("shows the original words and context without assigning confidence to a rewritten draft", () => {
    render(<RecognitionWordReview words={[word]} original="The tailie text." />);
    expect(screen.getByText("Words to check in the original")).toBeInTheDocument();
    expect(screen.getByText("The recognizer gave lower scores to these original words. They may still be correct.")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Original words to check")).getByText("tailie")).toBeInTheDocument();
    expect(screen.getByText("The tailie text.")).toBeInTheDocument();
    expect(screen.queryByText(/0\.533|53\.3%|0\.4/)).not.toBeInTheDocument();
  });

  it("hides missing metadata and metadata without original recognition", () => {
    const { container, rerender } = render(<RecognitionWordReview words={undefined} original="Some text." />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RecognitionWordReview words={[word]} original={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("rejects malformed scores, timing data, blanks, and words absent from the original", () => {
    const entries = [null, {}, { ...word, word: " " }, { ...word, word: "tail" },
      { ...word, word: "rewritten" }, { ...word, score: NaN }, { ...word, score: Infinity },
      { ...word, score: -0.1 }, { ...word, score: 1.1 }, { ...word, score: 0.6 },
      { ...word, score: "0.5" }, { ...word, startTime: -1 }, { ...word, endTime: Infinity },
      { ...word, endTime: 0.1 }, word];
    expect(recognitionWordsToReview(entries, "The tailie text.")).toEqual([word]);
  });

  it("matches literal punctuation and whole non-English words", () => {
    const entries = [{ ...word, word: "c++" }, { ...word, word: "c" }, { ...word, word: "你好" }];
    expect(recognitionWordsToReview(entries, "Use c++ and 你好.")).toEqual(entries);
    expect(recognitionWordsToReview([{ ...word, word: "你" }], "你好")).toEqual([]);
  });

  it("limits untrusted input and keeps remaining words behind details", () => {
    const words = Array.from({ length: 140 }, (_, index) => ({ ...word, word: `word${index}` }));
    const original = words.map((entry) => entry.word).join(" ");
    expect(recognitionWordsToReview(words, original)).toHaveLength(128);
    render(<RecognitionWordReview words={words} original={original} />);
    expect(within(screen.getByLabelText("Original words to check")).getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getByText("116 more original words to check.")).toBeInTheDocument();
    expect(screen.getByLabelText("More original words to check").closest("details")).not.toHaveAttribute("open");
  });

  it("drops old hints when the original source changes", () => {
    const { container, rerender } = render(<RecognitionWordReview words={[word]} original="tailie text" />);
    expect(screen.getByLabelText("Original words to check")).toBeInTheDocument();
    rerender(<RecognitionWordReview words={[word]} original="new capture" />);
    expect(container).toBeEmptyDOMElement();
  });
});
