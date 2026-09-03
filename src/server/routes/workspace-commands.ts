import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { chatService } from '../services/chat-service.js';
import { discoverInstalledSkills, skillCommands } from '../services/skill-inventory.js';
import { permittedSkills } from '../services/skill-input.js';
import { sessionSkillOptions } from '../services/session-skills.js';
import type { BackendId } from '../services/agent-backends.js';
import { codexAppServerManager } from '../services/codex-app-server-manager.js';

const router = Router({ mergeParams: true });

// GET /api/workspaces/:id/commands
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res
        .status(404)
        .json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const session = sessionId ? workspaceStore.getLocalSession(sessionId) : undefined;
    if (sessionId && (!session || session.workspaceId !== workspaceId)) {
      res.status(404).json({ error: 'Session not found in this workspace' }); return;
    }
    const backend = session?.backend ?? req.query.backend ?? 'claude';
    if (!['claude', 'codex', 'opencode'].includes(String(backend))) {
      res.status(400).json({ error: 'Unsupported backend' }); return;
    }
    commandsService.watchSkills(workspace.folderPath);
    const installations = await discoverInstalledSkills(workspace.folderPath);
    const selected = permittedSkills(installations, backend as BackendId, { ...sessionSkillOptions(session), cwd: workspace.folderPath });
    const skills = skillCommands(selected, backend as BackendId);
    const installedNames = new Set(installations.flatMap(skill => [skill.name, skill.invocationName]));
    if (backend === 'codex') {
      // Runtime validation also honors Codex's disabled Skills configuration.
      const native = await codexAppServerManager.listSkills(workspace.folderPath);
      const nativePaths = new Set(native.map(skill => skill.path));
      const commands = [...skills.filter(skill => nativePaths.has(skill.skillPath)), ...native.filter(skill => !installedNames.has(skill.name)).map(skill => ({ name: skill.name, description: skill.description, skillPath: skill.path }))];
      res.json({ commands, partial: false }); return;
    }
    if (backend === 'opencode') {
      const native = sessionId ? await chatService.getSessionBackendCommands(sessionId) : [];
      res.json({ commands: [...native.filter(command => !installedNames.has(command.name)), ...skills], partial: false }); return;
    }
    const result = await commandsService.getCommands(workspace);
    res.json({ ...result, commands: [...result.commands.filter(command => !installedNames.has(command.name)), ...skills] });
  } catch (error) {
    console.error('Failed to fetch commands:', error);
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

export default router;
