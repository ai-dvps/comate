/**
 * Client-side mirror of the server-side WeCom bot isolation policy shape.
 *
 * Defined separately (not imported from src/server) so the client bundle does
 * not pull in server modules. Keep in sync with
 * src/server/models/workspace.ts.
 */

export interface WeComBotIsolationSettings {
  adminUserIds: string[];
  defaultAllowedSkills: string[];
  adminAllowedSkills: string[];
}

export const DEFAULT_ISOLATION_SETTINGS: WeComBotIsolationSettings = {
  adminUserIds: [],
  defaultAllowedSkills: [],
  adminAllowedSkills: [],
};
