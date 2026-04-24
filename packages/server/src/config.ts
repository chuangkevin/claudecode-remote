import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const claudeDataDir = process.env.CLAUDE_DATA_DIR ?? join(homedir(), ".claude");

export const config = {
  port: parseInt(process.env.PORT ?? "9224", 10),
  host: process.env.HOST ?? "0.0.0.0",
  claudeDataDir,
  workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
  webRoot: join(__dirname, "../../web/dist"),
};

console.log("✓ Config loaded, will use Claude Code CLI");
console.log(`📂 Claude data dir: ${claudeDataDir}`);
console.log(`📁 Workspace root: ${config.workspaceRoot}`);
