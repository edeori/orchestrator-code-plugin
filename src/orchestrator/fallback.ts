import type { AgentId, AgentModel } from "../agents/agent";

type ModelClass = "fast" | "balanced" | "powerful";

export function alternateAgent(agent: AgentId): AgentId {
  return agent === "claude" ? "codex" : "claude";
}

/** Picks the closest available cross-provider model by capability class. */
export function selectEquivalentModel(
  catalog: AgentModel[],
  sourceModel: AgentModel,
  targetAgent: AgentId
): AgentModel {
  const targetModels = catalog.filter((model) => model.agent === targetAgent);
  if (!targetModels.length) throw new Error(`No allowed ${targetAgent} fallback model is available.`);

  const sourceClass = classifyModel(sourceModel);
  const equivalent = targetModels.filter((model) => classifyModel(model) === sourceClass);
  return equivalent.find((model) => model.isDefault) ?? equivalent[0] ??
    targetModels.find((model) => model.isDefault) ?? targetModels[0];
}

export function describeModelClass(model: AgentModel): string {
  return classifyModel(model);
}

function classifyModel(model: AgentModel): ModelClass {
  const name = `${model.id} ${model.displayName}`.toLowerCase();
  if (/(?:^|[-_.\s])(haiku|mini|nano|flash|spark)(?:$|[-_.\s])/.test(name)) return "fast";
  if (/(?:^|[-_.\s])(opus|pro)(?:$|[-_.\s])/.test(name)) return "powerful";
  return "balanced";
}
