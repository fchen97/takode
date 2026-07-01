export type CreationStepId =
  | "resolving_env"
  | "fetching_git"
  | "checkout_branch"
  | "pulling_git"
  | "creating_worktree"
  | "pulling_image"
  | "building_image"
  | "creating_container"
  | "copying_workspace"
  | "running_init_script"
  | "launching_cli";

export interface CreationProgressEvent {
  step: CreationStepId;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}
