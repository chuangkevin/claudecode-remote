import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { config } from "../config.js";

const execAsync = promisify(exec);

export interface ToolResult {
  output?: string;
  error?: string;
}

export async function executeBash(command: string, cwd?: string): Promise<ToolResult> {
  try {
    const workingDir = cwd || config.workspaceRoot;
    const { stdout, stderr } = await execAsync(command, {
      cwd: workingDir,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      output: stdout || stderr || "命令執行成功",
    };
  } catch (error: any) {
    return {
      error: error.message || "命令執行失敗",
      output: error.stdout || error.stderr,
    };
  }
}

export async function readFileContent(filePath: string): Promise<ToolResult> {
  try {
    const absolutePath = resolve(config.workspaceRoot, filePath);

    if (!existsSync(absolutePath)) {
      return { error: `檔案不存在: ${filePath}` };
    }

    const content = await readFile(absolutePath, "utf-8");
    return { output: content };
  } catch (error: any) {
    return { error: `讀取檔案失敗: ${error.message}` };
  }
}

export async function writeFileContent(
  filePath: string,
  content: string
): Promise<ToolResult> {
  try {
    const absolutePath = resolve(config.workspaceRoot, filePath);
    const dir = dirname(absolutePath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(absolutePath, content, "utf-8");
    return { output: `檔案寫入成功: ${filePath}` };
  } catch (error: any) {
    return { error: `寫入檔案失敗: ${error.message}` };
  }
}

export async function editFile(
  filePath: string,
  oldString: string,
  newString: string
): Promise<ToolResult> {
  try {
    const readResult = await readFileContent(filePath);
    if (readResult.error) {
      return readResult;
    }

    const content = readResult.output || "";
    if (!content.includes(oldString)) {
      return { error: `找不到要替換的文字` };
    }

    const newContent = content.replace(oldString, newString);
    return await writeFileContent(filePath, newContent);
  } catch (error: any) {
    return { error: `編輯檔案失敗: ${error.message}` };
  }
}

export async function grepFiles(
  pattern: string,
  path?: string,
  filePattern?: string
): Promise<ToolResult> {
  try {
    const searchPath = path || config.workspaceRoot;
    let command = "";

    if (process.platform === "win32") {
      command = `Get-ChildItem -Path "${searchPath}" -Recurse -File`;
      if (filePattern) {
        command += ` -Include "${filePattern}"`;
      }
      command += ` | Select-String -Pattern "${pattern}" | Select-Object -First 50`;
    } else {
      command = `grep -r "${pattern}" "${searchPath}"`;
      if (filePattern) {
        command += ` --include="${filePattern}"`;
      }
      command += ` | head -50`;
    }

    return await executeBash(command);
  } catch (error: any) {
    return { error: `搜尋失敗: ${error.message}` };
  }
}

export async function globFiles(
  pattern: string,
  path?: string
): Promise<ToolResult> {
  try {
    const searchPath = path || config.workspaceRoot;
    let command = "";

    if (process.platform === "win32") {
      command = `Get-ChildItem -Path "${searchPath}" -Recurse -File -Filter "${pattern}" | Select-Object -ExpandProperty FullName`;
    } else {
      command = `find "${searchPath}" -name "${pattern}" -type f`;
    }

    return await executeBash(command);
  } catch (error: any) {
    return { error: `檔案搜尋失敗: ${error.message}` };
  }
}

export async function listDirectory(path?: string): Promise<ToolResult> {
  try {
    const targetPath = path || config.workspaceRoot;
    let command = "";

    if (process.platform === "win32") {
      command = `Get-ChildItem -Path "${targetPath}" | Format-Table Name, Length, LastWriteTime -AutoSize`;
    } else {
      command = `ls -lah "${targetPath}"`;
    }

    return await executeBash(command);
  } catch (error: any) {
    return { error: `列出目錄失敗: ${error.message}` };
  }
}
