export function evaluateAppMatrixTerminalStatus(artifact) {
  const violations = [];
  const closesMatrixRow = artifact?.rowClosure?.closesMatrixRow === true;
  const outOfScope = artifact?.status === "PASS_OUT_OF_SCOPE";

  if (outOfScope) {
    if (artifact?.checksAllPassed !== true) {
      violations.push("A PASS_OUT_OF_SCOPE artifact must still record checksAllPassed true.");
    }
    if (artifact?.pass === true) {
      violations.push("A PASS_OUT_OF_SCOPE artifact must not report pass true: it closes no matrix row.");
    }
    if (closesMatrixRow) {
      violations.push(
        "A PASS_OUT_OF_SCOPE artifact must record rowClosure.closesMatrixRow false; that is the " +
          "whole reason it is out of scope.",
      );
    }
  } else if (artifact?.status !== "PASS" || artifact?.pass !== true) {
    violations.push("Artifact must be PASS with pass true, or PASS_OUT_OF_SCOPE.");
  } else if (!closesMatrixRow) {
    violations.push(
      "A PASS artifact must close the matrix row it names (rowClosure.closesMatrixRow true). A run " +
        "that read its text back somewhere other than this product must terminate as " +
        "PASS_OUT_OF_SCOPE instead.",
    );
  }

  if (artifact?.verifyMode === "local-http-probe" && artifact?.status === "PASS") {
    violations.push(
      "local-http-probe reads back a harness-owned page, so it can never terminate as PASS. " +
        "Expected PASS_OUT_OF_SCOPE.",
    );
  }

  return violations;
}
