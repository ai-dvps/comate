export interface WorkspaceSettings {
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomBotEnabled?: boolean;
  wecomBotName?: string;
  wecomCorpId?: string;
  wecomCorpSecret?: string;
  wecomFilePromptTemplate?: string;
}

export interface Skill {
  name: string;
}

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
}

export interface Hook {
  name: string;
  scriptPath: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  folderPath: string;
  settings: WorkspaceSettings;
  skills: Skill[];
  mcpServers: McpServer[];
  hooks: Hook[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  folderPath: string;
  settings?: WorkspaceSettings;
  skills?: Skill[];
  mcpServers?: McpServer[];
  hooks?: Hook[];
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  folderPath?: string;
  settings?: WorkspaceSettings;
  skills?: Skill[];
  mcpServers?: McpServer[];
  hooks?: Hook[];
}
