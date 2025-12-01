// src/extension.ts
//
// Shrimpl VS Code extension entry point.
// This file wires VS Code to the Shrimpl Language Server (LSP).
//
// Behavior overview:
//
// 1. If the user sets `shrimpl.lsp.path` in VS Code settings, that value is
//    used as the language server command. It supports VS Code-style
//    variables like `${workspaceFolder}` and `${workspaceFolderBasename}`
//    and relative paths are resolved against the first workspace folder.
//
// 2. If `shrimpl.lsp.path` is empty or not set, the extension falls back to
//    a bundled platform-specific binary located in `server/` inside the
//    extension:
//
//       - Windows x64:  server/shrimpl-lsp-win32-x64.exe
//       - macOS arm64: server/shrimpl-lsp-darwin-arm64
//       - Linux x64:   server/shrimpl-lsp-linux-x64
//
//    The filename is chosen via `platformBinaryName()` and resolved using
//    `context.asAbsolutePath(path.join("server", ...))`.
//
// 3. The extension sets up a `LanguageClient` from `vscode-languageclient`
//    to communicate with the server and registers it for disposal.
//
// 4. Configuration changes to `shrimpl.lsp.path` are surfaced via a
//    notification suggesting the user reload VS Code.

import * as vscode from "vscode";
import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/**
 * Return the bundled LSP binary name for the current platform.
 *
 * Files expected under the extension's `server/` directory:
 *
 *   - Windows (x64): "shrimpl-lsp-win32-x64.exe"
 *   - macOS (arm64): "shrimpl-lsp-darwin-arm64"
 *   - Linux (x64):   "shrimpl-lsp-linux-x64"
 *
 * You can extend this function later if you add more targets.
 */
function platformBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return "shrimpl-lsp-win32-x64.exe";
  }

  if (platform === "darwin" && arch === "arm64") {
    return "shrimpl-lsp-darwin-arm64";
  }

  // Default / fallback: Linux x64
  return "shrimpl-lsp-linux-x64";
}

/**
 * Resolve VS Code style variables and workspace-relative paths
 * in a configured LSP command.
 *
 * Supported variables:
 *  - ${workspaceFolder}
 *  - ${workspaceFolderBasename}
 *
 * Behavior:
 *  - If the value has no slashes (for example "shrimpl-lsp"), it is treated
 *    as a plain command on PATH and returned as is.
 *  - If the value has slashes and is not absolute, it is resolved under the
 *    first workspace folder.
 */
function resolveServerCommand(
  rawValue: string,
  outputChannel: vscode.OutputChannel,
): string {
  const trimmed = rawValue.trim();

  const folders = vscode.workspace.workspaceFolders;
  let wsPath: string | undefined;
  let wsName: string | undefined;

  if (folders && folders.length > 0) {
    wsPath = folders[0].uri.fsPath;
    wsName = folders[0].name;
  }

  let resolved = trimmed;

  if (wsPath) {
    resolved = resolved.replace(/\$\{workspaceFolder\}/g, wsPath);
  }
  if (wsName) {
    resolved = resolved.replace(
      /\$\{workspaceFolderBasename\}/g,
      wsName,
    );
  }

  const hasSlash = resolved.includes("/") || resolved.includes("\\");
  const isAbsolute = path.isAbsolute(resolved);

  // If it looks like a path (has a slash) and is not absolute yet,
  // resolve under the workspace folder if available.
  if (hasSlash && !isAbsolute && wsPath) {
    resolved = path.join(wsPath, resolved);
  }

  outputChannel.appendLine(
    `[Shrimpl] Raw LSP command from settings: ${rawValue}`,
  );
  outputChannel.appendLine(
    `[Shrimpl] Resolved LSP command to: ${resolved}`,
  );

  return resolved;
}

/**
 * Compute the command to use for the Shrimpl language server.
 *
 * Priority:
 *   1) If `shrimpl.lsp.path` is set and non-empty, use that value (after
 *      variable/path resolution).
 *   2) Otherwise, fall back to the bundled platform-specific binary under
 *      the extension's `server/` directory.
 */
function getServerCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): string {
  const config = vscode.workspace.getConfiguration("shrimpl");
  const rawConfigValue = config.get<string>("lsp.path") ?? "";
  const trimmed = rawConfigValue.trim();

  if (trimmed.length > 0) {
    outputChannel.appendLine(
      "[Shrimpl] Using custom LSP command from setting 'shrimpl.lsp.path'.",
    );
    return resolveServerCommand(trimmed, outputChannel);
  }

  const bundledBinary = platformBinaryName();
  const absoluteBundledPath = context.asAbsolutePath(
    path.join("server", bundledBinary),
  );

  outputChannel.appendLine(
    "[Shrimpl] No custom 'shrimpl.lsp.path' configured. " +
      `Using bundled language server binary: ${absoluteBundledPath}`,
  );

  return absoluteBundledPath;
}

/**
 * Activate the Shrimpl extension.
 *
 * This sets up the language client, starts the Shrimpl LSP, and hooks
 * configuration-change events.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Shrimpl");
  const traceOutputChannel =
    vscode.window.createOutputChannel("Shrimpl LSP Trace");

  const serverCommand = getServerCommand(context, outputChannel);

  const env = {
    ...process.env,
  };

  const serverOptions: ServerOptions = {
    run: {
      command: serverCommand,
      args: [],
      options: { env },
    },
    debug: {
      command: serverCommand,
      args: ["--debug"],
      options: { env },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "shrimpl" },
      { scheme: "untitled", language: "shrimpl" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.shr"),
    },
    outputChannel,
    traceOutputChannel,
  };

  client = new LanguageClient(
    "shrimplLanguageServer",
    "Shrimpl Language Server",
    serverOptions,
    clientOptions,
  );

  try {
    outputChannel.appendLine("[Shrimpl] Starting language server...");

    // Register the client itself for disposal
    context.subscriptions.push(client);

    // Start the client; resolves when the server is ready
    await client.start();

    outputChannel.appendLine("[Shrimpl] Language server is ready.");
    vscode.window.showInformationMessage(
      "[Shrimpl] Language server started.",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(
      `[Shrimpl] Failed to start language server: ${msg}`,
    );
    vscode.window.showErrorMessage(
      `[Shrimpl] Failed to start language server: ${msg}`,
    );
  }

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("shrimpl.lsp.path")) {
        outputChannel.appendLine(
          "[Shrimpl] Configuration 'shrimpl.lsp.path' changed. " +
            "Please reload VS Code to restart the language server with the new path.",
        );
        vscode.window.showInformationMessage(
          "[Shrimpl] 'shrimpl.lsp.path' changed. Reload the window to apply the new language server path.",
        );
      }
    }),
  );
}

/**
 * Deactivate the Shrimpl extension.
 *
 * Stops the language client and clears the global reference.
 */
export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    await client.stop();
  } finally {
    client = undefined;
  }
}
