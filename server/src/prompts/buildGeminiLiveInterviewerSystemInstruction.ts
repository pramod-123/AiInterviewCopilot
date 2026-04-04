import { PromptLoader } from "./PromptLoader.js";

const loader = new PromptLoader();

/**
 * Full system instruction for Gemini Live: **interview question first**, then static prompt from
 * `agents/gemini-live-interviewer/AGENT.md` (question comes from {@link InterviewLiveSession.question}).
 */
export function buildGeminiLiveInterviewerSystemInstruction(problemText: string | null | undefined): string {
  const base = loader.loadAgentSync("gemini-live-interviewer");
  const problem =
    problemText && problemText.trim().length > 0
      ? problemText.trim()
      : "No problem statement was provided on the session; infer context only from what the candidate says.";

  return [
    "## Interview question (read first; your opening turn follows AGENT.md: greet, then give the full solution)",
    "",
    problem,
    "",
    "Your voice is recorded into the **same session** as the candidate's screen share and microphone—their recording includes you. Speak clearly and at a steady pace.",
    "",
    "---",
    "",
    base,
  ].join("\n");
}
